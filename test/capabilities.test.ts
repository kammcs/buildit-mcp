/**
 * Capability detection with a stand-in machine: the operating system, the
 * programs on the PATH (without running them), the Android SDK and Xcode
 * folders, probes that fail or hang, and that only tag names of the fixed
 * list ever come out. Also the tag rule, --capabilities and
 * BUILDIT_CAPABILITIES.
 */
import { describe, expect, it } from 'vitest';

import {
  detectCapabilities,
  normalizeCapabilities,
  osCapability,
  parseCapabilitiesOption,
  SUGGESTED_CAPABILITIES,
  type DetectionHost,
} from '../src/capabilities.js';
import { parseCli } from '../src/config.js';

/** A machine with these files (programs), folders and links, and nothing else. */
function host(init: {
  platform: NodeJS.Platform;
  env?: Record<string, string>;
  files?: string[];
  dirs?: string[];
  links?: Record<string, string>;
  timeoutMs?: number;
  /** Paths whose probe never answers, or throws. */
  hang?: string[];
  fail?: string[];
}): DetectionHost & { probed: string[] } {
  const probed: string[] = [];
  const slow = (path: string): Promise<boolean> | undefined => {
    if (init.hang?.includes(path)) return new Promise(() => undefined);
    if (init.fail?.includes(path)) return Promise.reject(new Error('EACCES /secret/path'));
    return undefined;
  };
  return {
    probed,
    platform: init.platform,
    env: init.env ?? {},
    timeoutMs: init.timeoutMs ?? 50,
    isExecutable(path) {
      probed.push(path);
      return slow(path) ?? Promise.resolve((init.files ?? []).includes(path));
    },
    isDirectory(path) {
      probed.push(path);
      return slow(path) ?? Promise.resolve((init.dirs ?? []).includes(path));
    },
    readLink(path) {
      probed.push(path);
      return Promise.resolve(init.links?.[path]);
    },
  };
}

describe('detectCapabilities', () => {
  it('names the operating system', async () => {
    expect(await detectCapabilities(host({ platform: 'win32' }))).toEqual(['windows']);
    expect(await detectCapabilities(host({ platform: 'darwin' }))).toEqual(['macos']);
    expect(await detectCapabilities(host({ platform: 'linux' }))).toEqual(['linux']);
    expect(await detectCapabilities(host({ platform: 'freebsd' }))).toEqual([]);
    expect(osCapability('aix')).toBeUndefined();
  });

  it('finds programs on a Windows PATH by PATHEXT, without running them', async () => {
    const h = host({
      platform: 'win32',
      env: {
        Path: 'C:\\Tools\\flutter\\bin;"C:\\Program Files\\Docker\\bin";C:\\Tools\\cargo\\bin',
        PATHEXT: '.COM;.EXE;.BAT;.CMD',
      },
      files: [
        'C:\\Tools\\flutter\\bin\\flutter.bat',
        'C:\\Program Files\\Docker\\bin\\docker.exe',
        'C:\\Tools\\cargo\\bin\\cargo.exe',
      ],
    });
    expect(await detectCapabilities(h)).toEqual(['docker', 'flutter', 'rust', 'windows']);
    expect(h.probed).toContain('C:\\Program Files\\Docker\\bin\\docker.exe');
  });

  it('finds programs on a POSIX PATH, and the Android SDK by its folder or adb', async () => {
    const linux = host({
      platform: 'linux',
      env: { PATH: '/usr/local/bin:/usr/bin', ANDROID_HOME: '/opt/android-sdk' },
      files: ['/usr/bin/docker', '/usr/local/bin/rustc'],
      dirs: ['/opt/android-sdk'],
    });
    expect(await detectCapabilities(linux)).toEqual(['android', 'docker', 'linux', 'rust']);

    const adb = host({
      platform: 'linux',
      env: { PATH: '/opt/platform-tools', ANDROID_SDK_ROOT: '/missing' },
      files: ['/opt/platform-tools/adb'],
    });
    expect(await detectCapabilities(adb)).toEqual(['android', 'linux']);
  });

  it('finds Xcode and the iOS SDK on macOS from the folder xcode-select chose', async () => {
    const dev = '/Applications/Xcode-16.app/Contents/Developer';
    const mac = host({
      platform: 'darwin',
      env: { PATH: '/opt/homebrew/bin:/usr/bin' },
      files: ['/opt/homebrew/bin/flutter', '/usr/bin/xcodebuild'],
      links: { '/var/db/xcode_select_link': dev },
      dirs: [dev, `${dev}/Platforms/iPhoneOS.platform`],
    });
    expect(await detectCapabilities(mac)).toEqual(['flutter', 'ios', 'macos', 'xcode']);
  });

  it('does not count the command line tools alone as Xcode', async () => {
    const tools = host({
      platform: 'darwin',
      env: { PATH: '/usr/bin' },
      files: ['/usr/bin/xcodebuild'],
      links: { '/var/db/xcode_select_link': '/Library/Developer/CommandLineTools' },
      dirs: ['/Library/Developer/CommandLineTools', '/Applications/Xcode.app/Contents/Developer'],
    });
    expect(await detectCapabilities(tools)).toEqual(['macos']);
    // DEVELOPER_DIR wins, and without the iPhoneOS platform there is no ios.
    const env = host({
      platform: 'darwin',
      env: { DEVELOPER_DIR: '/Applications/Xcode.app/Contents/Developer' },
      dirs: ['/Applications/Xcode.app/Contents/Developer'],
    });
    expect(await detectCapabilities(env)).toEqual(['macos', 'xcode']);
  });

  it('never looks for Xcode off macOS, and never detects web or gpu', async () => {
    const win = host({ platform: 'win32', dirs: ['/Applications/Xcode.app/Contents/Developer'] });
    expect(await detectCapabilities(win)).toEqual(['windows']);
    expect(win.probed.some((p) => p.includes('Xcode'))).toBe(false);
  });

  it('counts a probe that fails or hangs as not found, within its time limit', async () => {
    const h = host({
      platform: 'linux',
      env: { PATH: '/slow:/broken:/ok' },
      files: ['/ok/flutter', '/slow/docker'],
      hang: ['/slow/docker', '/slow/cargo', '/slow/rustc', '/slow/adb', '/slow/flutter'],
      fail: ['/broken/docker', '/broken/flutter'],
      timeoutMs: 30,
    });
    const started = Date.now();
    // Flutter's probe hangs on /slow too, so it times out: not found, like docker.
    expect(await detectCapabilities(h)).toEqual(['linux']);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('never fails, whatever the machine does', async () => {
    const broken: DetectionHost = {
      platform: 'darwin',
      env: { PATH: '/usr/bin' },
      timeoutMs: 20,
      isExecutable: () => {
        throw new Error('boom');
      },
      isDirectory: () => Promise.reject(new Error('boom')),
      readLink: () => Promise.reject(new Error('boom')),
    };
    expect(await detectCapabilities(broken)).toEqual(['macos']);
  });

  it('only ever returns tag names from the suggested list: no paths or versions', async () => {
    const h = host({
      platform: 'darwin',
      env: { PATH: '/opt/flutter-3.47.3/bin:/usr/local/bin' },
      files: [
        '/opt/flutter-3.47.3/bin/flutter',
        '/usr/local/bin/docker',
        '/usr/local/bin/cargo',
        '/usr/local/bin/adb',
      ],
      links: { '/var/db/xcode_select_link': '/Applications/Xcode.app/Contents/Developer' },
      dirs: [
        '/Applications/Xcode.app/Contents/Developer',
        '/Applications/Xcode.app/Contents/Developer/Platforms/iPhoneOS.platform',
      ],
    });
    const tags = await detectCapabilities(h);
    expect(tags).toEqual(['android', 'docker', 'flutter', 'ios', 'macos', 'rust', 'xcode']);
    for (const tag of tags) {
      expect(SUGGESTED_CAPABILITIES as readonly string[]).toContain(tag);
      expect(tag).toMatch(/^[a-z]+$/);
    }
    expect(JSON.stringify(tags)).not.toMatch(/\/|3\.47|opt|bin/);
  });
});

describe('the tag rule', () => {
  it('normalises tags as the server stores them', () => {
    expect(normalizeCapabilities([' MacOS', 'ios', 'macos', '', 'c++'], 20)).toEqual([
      'c++',
      'ios',
      'macos',
    ]);
  });

  it('refuses bad tags and too many', () => {
    expect(() => normalizeCapabilities(['-mac'], 20)).toThrow(/Not a capability tag: "-mac"/);
    expect(() => normalizeCapabilities(['a'.repeat(33)], 20)).toThrow(/Not a capability tag/);
    expect(() => normalizeCapabilities(['mac os'], 20)).toThrow(/Not a capability tag/);
    expect(() =>
      normalizeCapabilities(
        Array.from({ length: 21 }, (_, i) => `t${i}`),
        20,
      ),
    ).toThrow(/At most 20/);
  });

  it('reads --capabilities and BUILDIT_CAPABILITIES, with "none" for none', () => {
    expect(parseCapabilitiesOption('macos,iOS  flutter')).toEqual(['flutter', 'ios', 'macos']);
    expect(parseCapabilitiesOption('none')).toEqual([]);
    expect(() => parseCapabilitiesOption(' , ')).toThrow(/Give capability tags/);
  });

  it('connect takes --capabilities, checked', () => {
    const action = parseCli(
      ['connect', '--project', 'DEMO', '--capabilities', 'MacOS,ios'],
      {},
      '/tmp/demo',
    );
    expect(action).toMatchObject({ kind: 'connect', options: { capabilities: ['ios', 'macos'] } });
    const none = parseCli(['connect', '--project', 'DEMO', '--capabilities', 'none'], {}, '/tmp');
    expect(none).toMatchObject({ kind: 'connect', options: { capabilities: [] } });
    const detect = parseCli(['connect', '--project', 'DEMO'], {}, '/tmp');
    expect(detect.kind === 'connect' && detect.options.capabilities).toBe(undefined);
    expect(() =>
      parseCli(['connect', '--project', 'DEMO', '--capabilities', 'mac/os'], {}, '/tmp'),
    ).toThrow(/--capabilities: Not a capability tag/);
  });

  it('channel mode takes BUILDIT_CAPABILITIES', () => {
    const action = parseCli(['--channel'], { BUILDIT_CAPABILITIES: 'linux,docker' }, '/tmp');
    expect(action.kind === 'run' && action.config.channel?.capabilities).toEqual([
      'docker',
      'linux',
    ]);
    const unset = parseCli(['--channel'], {}, '/tmp');
    expect(unset.kind === 'run' && unset.config.channel?.capabilities).toBe(undefined);
    expect(() => parseCli(['--channel'], { BUILDIT_CAPABILITIES: '!!' }, '/tmp')).toThrow(
      /BUILDIT_CAPABILITIES: Not a capability tag/,
    );
  });
});
