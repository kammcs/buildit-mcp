/**
 * Small text helpers of the bridge's own posts: a stable message id from a
 * name, and a long text split into posts.
 */
import { createHash } from 'node:crypto';

import { REPLY_MAX_CHARS } from '../tools/reply.js';

/** A UUID made from a name, so the same post always gets the same message id. */
export function stableUuid(name: string): string {
  const h = createHash('sha256').update(name).digest();
  h.writeUInt8((h.readUInt8(6) & 0x0f) | 0x50, 6);
  h.writeUInt8((h.readUInt8(8) & 0x3f) | 0x80, 8);
  const hex = h.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** Splits text into posts of at most `max` characters, at a paragraph, line or word when it can. */
export function splitText(text: string, max: number = REPLY_MAX_CHARS): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = window.lastIndexOf('\n\n');
    if (cut < max / 2) cut = window.lastIndexOf('\n');
    if (cut < max / 2) cut = window.lastIndexOf(' ');
    if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest !== '') out.push(rest);
  return out;
}
