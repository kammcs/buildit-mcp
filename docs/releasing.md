# Releasing

A release ships the same version through four channels: npm, the container image on GHCR, the Claude Desktop bundle on the GitHub release, and the MCP Registry. Run every step from a clean checkout of `main`. Tokens come from your environment or your tools' own login, never from a file in the repository.

## Before

1. Set the version in `package.json` (and `package-lock.json`, with `npm version <x.y.z> --no-git-tag-version`) and in `server.json` (its `version`, the npm package's `version` and the image tag). `npm test` fails while they disagree.
2. Move the changelog's "unreleased" section under the version and today's date.
3. Run the checks: `npm ci`, `npm run check`, `npm run inspect:docker` and `npm run conformance`.
4. Rerun the eval set ([evals/README.md](../evals/README.md)); a safety failure there blocks the release.
5. Commit, and tag the commit `v<x.y.z>`.

## Publish

1. **npm:** `npm publish` (it runs `npm run check` first). Check that `npx -y @kammcs/buildit-mcp@<x.y.z> --version` prints the version.
2. **Container image:** `docker login ghcr.io` with a token that can write packages, then `npm run image:publish`. It pushes `ghcr.io/kammcs/buildit-mcp:<x.y.z>` and `:<major>` for amd64 and arm64. On a first release, make the package public in its GitHub settings.
3. **Claude Desktop bundle:** `npm run bundle` writes `buildit-mcp-<x.y.z>.mcpb`.
4. **GitHub release:** push the tag, create a release for it with the changelog's section as notes, and attach the `.mcpb`.
5. **MCP Registry:** after npm and the image are live, `mcp-publisher login github` (as the `kammcs` account, for the `io.github.kammcs` namespace) and `mcp-publisher publish`. The Registry checks `mcpName` in the npm package and the `io.modelcontextprotocol.server.name` label on the image against `server.json`'s name.

## After

- Install from each channel once: `npx`, `docker run`, the bundle in Claude Desktop. Call `whoami` against a test org.
- Start a new "unreleased" section in the changelog.
