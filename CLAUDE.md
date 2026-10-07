# CLAUDE.md

Guidance for agents (and people) who build this repository.

## What this is

`buildit-mcp` is an [MCP](https://modelcontextprotocol.io) server for [buildIt.Social](https://buildit.social). It lets AI agents (Claude Code, Claude Desktop, Cursor, VS Code and others) work with one org's projects, items, comments, pages and channels through buildIt.Social's **agent API**, with a person's **personal access token**.

It is a thin adapter: each MCP tool call becomes one or a few calls to the agent API, which authenticates the token, acts as its owner, and enforces every permission. The server holds no secrets of its own and keeps no state between requests.

The design is in [docs/design.md](docs/design.md). Read it before changing behaviour.

## This repository is public

Everything here is public (MIT). Before every commit:

- **No secrets:** no tokens, keys, passwords or credentials, real or "temporary". Test tokens are made-up strings such as `buildit_pat_test_full_access` and only work against the in-process fake API. Never use a real token, and never call the real API (production or any other) from tests or scripts.
- **No private details:** no internal hostnames, server names, file paths or code from the product's private repositories, no customer or user data, no internal ticket or decision numbers, and no notes about how the work is organised. The only buildIt.Social URL in code is the public API default, `https://api.buildit.social/functions/v1/agent-api`.
- **Fixtures are invented:** "Example Org", "Test User", `example.com` addresses, project keys like `DEMO`.
- **The gitleaks pre-commit hook must pass.** Enable it once per clone with `git config core.hooksPath .githooks`; it needs [gitleaks](https://github.com/gitleaks/gitleaks) on `PATH`. Never commit with `--no-verify`. `.gitleaks.toml` adds a rule for buildIt.Social token shapes on top of the defaults.
- GitHub Actions is off; the checks below run locally.

## The API contract

The agent API is built and maintained by the buildIt.Social product team, in a private repository. Its contract is an **OpenAPI 3.1 document**, which the maintainers copy into this repository (planned location: `openapi/openapi.json`). It is the only source of truth for endpoint shapes:

- Don't guess endpoints, fields or error codes. If something you need is not in the document, stop and ask the maintainers.
- The API's `/v1` only grows (new endpoints, new optional fields, new enum values), so parse responses tolerantly (`z.looseObject`) and treat unknown enum values as possible.
- Until the document lands, `src/api/types.ts` holds hand-written, minimal schemas for the two endpoints in use (`GET /v1/meta`, `GET /v1/me`).

## Architecture

```
src/
  index.ts              the buildit-mcp command: parse config, start stdio or HTTP
  config.ts             environment variables and flags, validated (never prints the token)
  log.ts                JSON logs to stderr, with token scrubbing
  version.ts            name, version, version comparison
  server.ts             McpServer for one caller: instructions, tool registration, error mapping
  errors.ts             ApiError -> tool result with isError and actionable text
  untrusted.ts          <untrusted_content> wrapping of people-written text
  api/client.ts         fetch wrapper: auth, X-Request-Id, X-Buildit-Tool, retries, timeouts, ApiError
  api/types.ts          hand-written schemas for /v1/meta and /v1/me (to be replaced, see above)
  toolsets/toolsets.ts  toolset names, scopes, defaults
  toolsets/registry.ts  ToolDefinition, defineTool, selectTools (gating and order)
  toolsets/catalog.ts   the list of every tool
  tools/whoami.ts       the first tool
  transports/stdio.ts   stdio: token from BUILDIT_TOKEN, identity read at startup
  transports/http.ts    Streamable HTTP: stateless, Bearer per request, Host/Origin checks
test/
  support/fake-api.ts   in-process fake of the agent API (made-up data)
  support/test-tools.ts stand-in tools across toolsets, for registry and transport tests
  *.test.ts             vitest
scripts/
  inspect.ts            MCP Inspector CLI smoke test (stdio and HTTP, both protocol eras)
  conformance.ts        official conformance suite against HTTP mode, offline
```

Key rules the code relies on:

- **stdout is the protocol in stdio mode.** Never write to it; log through `Logger` (stderr). ESLint forbids `console` in `src/`.
- **Never log tokens or content.** Log codes, ids, statuses and durations; never titles, descriptions, comments, query strings or bodies. The logger scrubs tokens as a backstop, not as permission.
- **Stateless.** Nothing about a caller survives the request (HTTP) or the connection (stdio). No caches keyed by token.
- **Tool descriptions are static text.** Never build them from server data.
- **People-written text is wrapped.** Every tool that returns titles, descriptions, comments, pages or messages passes them through `wrapUntrusted()`; short labels (names, keys) go through `sanitizeLabel()`.
- **API refusals are tool results**, not exceptions: throw `ApiError` (the client does) and `server.ts` turns it into `isError: true` with the code, message, hint and details.

## Adding a tool

1. Create `src/tools/<name>.ts` with `defineTool({...})`:
   - `name`: snake_case, stable once released (see the tool list in [docs/design.md](docs/design.md));
   - `toolset`: one of `items`, `comments`, `planning`, `pages`, `chat`, `admin`, `destructive`;
   - `scopes`: every token scope the tool needs (each must be listed by its toolset in `toolsets.ts`);
   - `annotations`: `readOnlyHint` is required; set `destructiveHint`, `idempotentHint` and `openWorldHint` honestly;
   - `inputSchema` and `outputSchema`: `z.object(...)` with `.describe()` on fields an agent must understand;
   - `run(args, ctx)`: call the API through `ctx.api` with `{ tool: '<name>', signal: ctx.signal }`, wrap people-written text, and return `{ structured, text }` (structured matches `outputSchema`; text is a short summary for clients that ignore structured output).
2. Add it to `CATALOG` in `src/toolsets/catalog.ts`.
3. Test it in `test/` against the fake API: extend `test/support/fake-api.ts` with the endpoint, following the OpenAPI document. Cover success, an API error, and any people-written field with a hostile value.
4. Update the tool tables in `README.md` and `docs/design.md`.

Destructive and admin changes never apply directly: a `propose_*` tool returns a preview and a plan handle, and `apply_plan` applies it after the person confirms. `buildInstructions()` adds the confirmation guidance once such tools exist.

## Using the OpenAPI document

When `openapi/openapi.json` arrives:

- Generate the request and response schemas into `src/api/generated/` (generated code is committed, never edited by hand; add a `generate` script and note the generator and version here).
- Keep `ApiClient` as the one place that does HTTP: generated schemas go through `api.requestParsed(method, path, schema, options)`, so auth, request ids, retries, timeouts and error mapping stay in one place.
- Replace `src/api/types.ts` with the generated `/v1/meta` and `/v1/me` schemas, and adjust `whoami` to the real field names.
- Make the fake API serve examples from the document, so tests can't drift from the contract.

## Checks

```sh
npm ci
npm run check         # lint (tsc + eslint), format:check, build, test
npm run inspect       # MCP Inspector CLI smoke test against the fake API
npm run conformance   # official conformance suite against HTTP mode, offline
```

`npm run check` must pass before every commit; run `inspect` and `conformance` when you touch transports or the server setup. All of them use only the in-process fake API and local ports, and clean up after themselves.

Dependencies are pinned to exact versions (`.npmrc` has `save-exact=true`) and `package-lock.json` is committed.

## Commits

- Small, focused commits with a clear message.
- Every commit message ends with the trailer agreed with the maintainers. For Claude Code sessions that is:

  ```
  Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
  ```

- Never force-push, rewrite published history or skip hooks.
