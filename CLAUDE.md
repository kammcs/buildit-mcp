# CLAUDE.md

Guidance for agents (and people) who build this repository.

## What this is

`buildit-mcp` is an [MCP](https://modelcontextprotocol.io) server for [buildIt.Social](https://buildit.social). It lets AI agents (Claude Code, Claude Desktop, Cursor, VS Code and others) work with one org's projects, items, comments, pages and channels through buildIt.Social's **agent API**, with a person's **personal access token**.

It is a thin adapter: each MCP tool call becomes one or a few calls to the agent API, which authenticates the token, acts as its owner, and enforces every permission. The server holds no secrets of its own and keeps no state between requests, beyond a 30-second cache of each token's scopes.

The design is in [docs/design.md](docs/design.md). Read it before changing behaviour.

## This repository is public

Everything here is public (MIT). Before every commit:

- **No secrets:** no tokens, keys, passwords or credentials, real or "temporary". Test tokens are made-up strings such as `buildit_pat_test_full_access` and only work against the in-process fake API. Never use a real token, and never call the real API (production or any other) from tests or scripts.
- **No private details:** no internal hostnames, server names, file paths or code from the product's private repositories, no customer or user data, no internal ticket or decision numbers, and no notes about how the work is organised. The only buildIt.Social URL in code is the public API default, `https://api.buildit.social/functions/v1/agent-api`.
- **Fixtures are invented:** "Example Org", "Test User", `example.com` addresses, project keys like `DEMO`.
- **The privacy guard must pass:** `npm run privacy` (and the test suite) fails on decision numbers, plan section signs, database files and internals, the owner's name, the private repository's name, emails outside `example.com`, private hostnames and the product team's project key. Extend its lists in `scripts/privacy.ts` when you find something else that must stay out; never weaken a rule to make a finding pass.
- **The gitleaks pre-commit hook must pass.** Enable it once per clone with `git config core.hooksPath .githooks`; it needs [gitleaks](https://github.com/gitleaks/gitleaks) on `PATH`. Never commit with `--no-verify`. `.gitleaks.toml` adds a rule for buildIt.Social token shapes on top of the defaults.
- GitHub Actions is off; the checks below run locally.

## The API contract

The agent API is built and maintained by the buildIt.Social product team, in a private repository. Its contract is an **OpenAPI 3.1 document**, which the maintainers copy into this repository as [`openapi/openapi.json`](openapi/openapi.json). It is the only source of truth for endpoint shapes:

- Don't guess endpoints, fields or error codes. If something you need is not in the document, stop and ask the maintainers.
- The API's `/v1` only grows (new endpoints, new optional fields, new enum values), so responses are parsed tolerantly: the generated response schemas keep unknown fields, accept unknown enum values and don't check string formats.
- Never edit `openapi/openapi.json` by hand. To take a new version: copy the API's document over it byte for byte, run `npm run privacy` (it must find nothing: if it does, ask the maintainers for a clean document instead of editing it), run `npm run generate`, run the checks, and commit the document and the generated code together.

### Generated code

`npm run generate` (`scripts/generate.ts`, using `scripts/codegen.ts`) writes `src/api/generated/` from the document. The converter is ours, small and dependency-free (it formats with the pinned Prettier), and fails loudly on any JSON Schema keyword it doesn't know. The output is deterministic, committed, and never edited by hand; `test/contract.test.ts` fails when it is out of date.

- `schemas.ts`: tolerant Zod schemas and types for every component (`ItemDetailSchema`, `ItemDetail`, ...), used to parse responses.
- `strict.ts`: exact schemas, each operation's `QUERY_SCHEMAS`, `REQUEST_SCHEMAS` and `RESPONSE_SCHEMAS`, and request types (`OperationIO`). The fake API uses them; `src/` imports only their types.
- `operations.ts`: `OPERATIONS` (method, path, parameters, `x-buildit-scope`, `requiredScopes` (all the scopes it needs; `x-buildit-required-scopes`, else the single scope), hints, errors, `discovery` (get_meta and get_me: no rate-limit unit, no `RateLimit-*` headers), response schema), `SCOPES` and `SCOPE_IMPLIES`, `ERROR_STATUS`, `ERROR_HINTS` (each code's next step, used when an older API sends no hint) and `PLAN_SCOPES` (all the scopes each plan action needs).

## Architecture

```
openapi/openapi.json    the agent API's contract (copied in, never edited)
src/
  index.ts              the buildit-mcp command: parse config, start stdio or HTTP
  config.ts             environment variables and flags, validated (never prints the token)
  log.ts                JSON logs to stderr, with token scrubbing
  version.ts            name, version, version comparison
  server.ts             McpServer for one caller: instructions, tools, resources, prompts, error mapping
  errors.ts             ApiError and ToolInputError -> tool result with isError and actionable text
  identity.ts           /v1/me failures (refused vs passing) and the per-token scope cache
  untrusted.ts          <untrusted_content> wrapping of people-written text
  resources.ts          buildit://items/{key} and buildit://pages/{id}
  prompts.ts            plan_epic, triage, standup
  api/client.ts         fetch wrapper: auth, X-Request-Id, X-Buildit-Tool, X-Buildit-Client, retries, timeouts
  api/operations.ts     typed calls by operationId (callOperation, behind ctx.call)
  api/generated/        generated from the contract (see above)
  toolsets/toolsets.ts  toolset names, scopes (from the contract), defaults
  toolsets/registry.ts  ToolDefinition, ToolContext, defineTool, selectTools (gating, order, apply_plan),
                        ResourceDefinition, PromptDefinition, selectGated
  toolsets/catalog.ts   the list of every tool, resource and prompt
  tools/shared.ts       input fields, output shapes and text helpers shared by the tools
  tools/whoami.ts       whoami
  tools/projects.ts     list_projects, describe_project, find_users
  tools/items-read.ts   search_items, get_item
  tools/items-write.ts  create_item, update_item, assign_item, transition_item, link_items,
                        unlink_items, rank_item
  tools/comments.ts     list_comments, add_comment
  tools/planning.ts     list_sprints, plan_sprint, list_releases, plan_release, write_release_notes
  tools/pages.ts        list_pages, get_page, create_page, update_page
  tools/chat.ts         list_channels, read_channel, read_thread
  tools/plans.ts        get_workflow, list_work_types, the propose_* tools, apply_plan
  tools/setup.ts        create_channel, create_project
  transports/stdio.ts   stdio: token from BUILDIT_TOKEN, identity read at startup and refreshed
  transports/http.ts    Streamable HTTP: stateless, Bearer per request, Host/Origin checks
test/
  support/fake-api.ts   in-process fake of the agent API on the generated contract (made-up data)
  support/harness.ts    an in-memory MCP client on the real catalog, and hostile-content checks
  support/test-tools.ts stand-in tools across toolsets, for registry and transport tests
  *.test.ts             vitest
scripts/
  codegen.ts, generate.ts  the generator (npm run generate)
  inspect.ts            MCP Inspector CLI smoke test (stdio and HTTP, both protocol eras)
  privacy.ts            the privacy guard (npm run privacy; test/privacy.test.ts runs it too)
  conformance.ts        official conformance suite against HTTP mode, offline
evals/                  realistic tasks a maintainer runs by hand against a test org
```

Key rules the code relies on:

- **stdout is the protocol in stdio mode.** Never write to it; log through `Logger` (stderr). ESLint forbids `console` in `src/`.
- **Never log tokens or content.** Log codes, ids, statuses and durations; never titles, descriptions, comments, query strings or bodies. The logger scrubs tokens as a backstop, not as permission.
- **Stateless.** Nothing about a caller survives the request (HTTP) or the connection (stdio), with one exception: `IdentityCache` (`src/identity.ts`) keeps each token's scopes (and whether it has project or channel limits) for 30 seconds in HTTP mode, so listing tools doesn't read `/v1/me` every time. It is keyed by an HMAC of the token (never the token), holds only those, is bounded, and is evicted on any auth error. Add no other cache keyed by token.
- **Tool descriptions are static text.** Never build them from server data.
- **People-written text is wrapped.** Every tool, resource and plan preview that returns titles, descriptions, comments, pages, messages, goals or descriptions passes them through `wrapUntrusted()`; short labels (names, keys) go through `sanitizeLabel()`.
- **API refusals are tool results**, not exceptions: throw `ApiError` (the client does) and `server.ts` turns it into `isError: true` with the code, message, hint and details.

## Adding a tool

1. Create the tool with `defineTool({...})` in the matching file under `src/tools/` (or a new one):
   - `name`: snake_case, stable once released (see the tool list in [docs/design.md](docs/design.md));
   - `toolset`: one of `items`, `comments`, `planning`, `pages`, `chat`, `admin`, `destructive`;
   - `scopes`: `scopesOf('<operationId>', ...)` for every operation the tool calls, so they come from the contract (each must be listed by its toolset in `toolsets.ts`); a `propose_*` tool uses `planScopesOf('<action>')`, since a plan takes its action's scopes; a tool is listed only with all of its scopes; set `unlimitedOnly` when the API refuses a token with project or channel limits (`create_channel`, `create_project`), so such a token doesn't see it;
   - `annotations`: `readOnlyHint` is required; set `destructiveHint`, `idempotentHint` and `openWorldHint` honestly, following the contract's `x-buildit-hints` for the operations it calls;
   - `description`: static text written for an agent: when to use the tool, how to name things (item keys such as DEMO-12, status and type names, people as `me` or an email), and what comes back;
   - `inputSchema` and `outputSchema`: `z.object(...)` with `.describe()` on fields an agent must understand;
   - `run(args, ctx)`: call the API with `ctx.call('<operationId>', { path, query, body })` (it sends the tool's name and the client's, and parses the response with the generated schema), wrap people-written text, and return `{ structured, text }` (structured matches `outputSchema`; text is a short summary for clients that ignore structured output). Throw `ToolInputError` for arguments that can't make a valid call; API errors are thrown for you.
2. Add it to `CATALOG` in `src/toolsets/catalog.ts`.
3. Test it in `test/` through `connect()` from `test/support/harness.ts`. If the fake API doesn't serve the operation yet, add it to `test/support/fake-api.ts` (the contract checks its requests, responses and error bodies). Cover success, the important API errors, and any people-written field with a hostile value (`HOSTILE`, `assertDefused`, `injectionIsInsideBlocks`); `afterEach` should expect `api.violations` to be empty. `api.compat` makes the fake answer like an older API, to test fallbacks; `api.advance(ms)` moves its clock (plan expiry).
4. Update the tool tables in `README.md` and `docs/design.md`, the tool lists in `test/tools-gating.test.ts`, `test/stdio.test.ts` and `scripts/inspect.ts`, and add or adjust tasks in `evals/tasks.md`.

Conventions the tools follow:

- **People-written text:** descriptions, comments, snippets and history values go through `wrapUntrusted()`, in the text and in structured content; titles in structured content and every name go through `sanitizeLabel()`; a list of items in the text is one block (`wrapLines()`).
- **Size:** pages default to 25; descriptions and comments are cut with a note on how to read more; one response (text and structured content together) stays well under 25,000 tokens. The tests check the largest cases.
- **Paging:** return `next_cursor`, and end the text with `nextPageHint()`.
- **Writes:** offer the contract's guards (`if_version`, `description_version`) and idempotency keys; when the agent gives no key, generate one and return it.

Destructive and admin changes never apply directly: a `propose_*` tool (named so) returns a preview and a plan handle through `create_plan`, and `apply_plan` applies it after the person confirms. `apply_plan` is marked `withPlans`, so the registry lists it whenever a `propose_*` tool is listed; `buildInstructions()` adds the confirmation guidance then. A new destructive or configuration change gets a `propose_*` tool, never a direct one. Creating something new that changes nothing existing (`create_channel`, `create_project`) applies directly, with an idempotency key. Elicitation is not used yet: the two-step flow must keep working with every client.

Resources and prompts are gated like tools, by toolset and scope (`selectGated`). A resource reads through the API like the matching tool and returns its text; a prompt is static text with the person's arguments, checked by a pattern, filled in.

## Checks

```sh
npm ci
npm run check         # lint (tsc + eslint), format:check, build, test
npm run inspect       # MCP Inspector CLI smoke test against the fake API
npm run conformance   # official conformance suite against HTTP mode, offline
npm run generate      # after a contract change; the tests fail if the output is stale
npm run privacy       # the privacy guard (the tests run it too)
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
