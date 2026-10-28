# Changelog

All notable changes to buildit-mcp are listed here. The project follows [semantic versioning](https://semver.org); see [Versions](README.md#versions) for what that means for tools.

## [0.5.0] - 2026-10-28

Built on version 1.6.0 of the agent API's contract. Questions, approval cards and "is writing" need a buildIt.Social server with agent API 1.6.0; on an older one, `ask` can't post (the plugin's hook then lets the terminal ask) and proposals keep the usual two steps.

### The buildit plugin for Claude Code

- **A Claude Code plugin** in this repository (`plugin/`, marketplace `buildit-mcp` in `.claude-plugin/marketplace.json`): `/plugin marketplace add kammcs/buildit-mcp`, then `/plugin install buildit@buildit-mcp`, and start Claude Code with `--dangerously-load-development-channels plugin:buildit@buildit-mcp`. It starts buildit-mcp in channel mode itself, so it replaces the `claude mcp add` server (remove that one first; `buildit-mcp status` warns when both are set up). Settings: the question wait (1 to 60 minutes, default 60) and whether questions go to buildIt.Social (default on). See [Questions and approvals in buildIt.Social](README.md#questions-and-approvals-in-builditsocial-plugin).
- **Claude's questions as cards.** The plugin hooks `AskUserQuestion`: the questions are posted as a card in your agent's conversation (one card per question: the question in full, its choices as a list with their details, multi-select where Claude allows it, and a field for an answer of your own; a choice or your own answer is enough), and your answer is handed to Claude, so the terminal doesn't ask. No answer in time, a dismissed card, or a session that ends while it waits closes the card and tells Claude nobody answered (it doesn't fall back to the terminal). With the questions setting off, or without a channel session, the terminal asks as usual.
- **`plugin-local/`**, the same plugin running a checkout's build (`dist/`), for trying it before a release is on npm: `claude --plugin-dir <checkout>/plugin-local --dangerously-load-development-channels plugin:buildit@inline`.
- **"<agent> is writing…"** shows in the thread while Claude works on your message, and stops when it replies, asks, posts an approval or ends its turn (the plugin's `Stop` hook), after 10 minutes without activity, and on shutdown.

### Channel mode

- **`ask`** (channel mode only): Claude asks you 1 to 4 multiple-choice questions as a card and waits for your answer (`wait_s`, default 10 minutes), which comes back inside an `untrusted_content` block. Only your answers count; the card closes at its deadline, when the call is cancelled, or when you dismiss it.
- **Approvals as cards.** In channel mode a `propose_*` tool also posts the preview as a card with Apply and Cancel, worded by buildIt.Social from its own preview. buildIt.Social applies the change on your tap, as you through your agent; `apply_plan` refuses such a plan (`plan_awaits_owner`), and Claude learns the outcome as a `<channel>` message with `event="plan_resolved"` (applied, cancelled, stale, failed or expired). If the card can't be posted, the usual preview-then-confirm flow stands.
- **One channel per folder:** the first channel server in a folder takes a lock; another one serves its tools without the channel, and its `reply` and `ask` say which is the channel.
- An agent session never applies plans: every `propose_*` with a session token posts its card, `apply_plan` explains `plan_card_required`, and the descriptions and channel instructions say so. A plan outcome `unknown` tells Claude to check the items.
- Event types this version doesn't know are skipped instead of failing the page of events.
- `turn_ended`, a tool only the plugin's `Stop` hook calls.

## [0.4.0] - 2026-10-28

Built on version 1.5.0 of the agent API's contract. Channel mode and the session commands need a buildIt.Social server that serves agent sessions; on an older one the channel stops with a clear log line, and everything else works as before.

### Channel mode

- **Talk to Claude Code from buildIt.Social.** `buildit-mcp --channel` (`BUILDIT_CHANNEL=true`) makes the server a Claude Code channel for a session of your personal agent: your messages to the agent in the app arrive in the running Claude Code session as `<channel>` events (with `thread_id`, `message_id` and `session`), and Claude answers in the same thread with the new `reply` tool. Only your own messages are passed on; a message you forwarded from someone else is passed on marked as their text (`forwarded="true"`, inside an `untrusted_content` block). The server declares `experimental["claude/channel"]` and stays on the 2025 handshake, since Claude Code doesn't register a channel on 2026-07-28. Start Claude Code with `--dangerously-load-development-channels server:buildit` until the channel is on its approved list. See [Talk to Claude Code from buildIt.Social](README.md#talk-to-claude-code-from-builditsocial).
- **`reply`** (channel mode only): text up to 4,000 characters, in the thread named or the one the latest message came in, with an idempotency key. Not listed in read-only mode.
- The server polls the session's events at the server's interval, acknowledges them only after handing them on, drops repeats, backs off when the API is busy or away, pauses while the session is suspended, says the session is offline when it stops, and, when the session is revoked or expires, stops polling and clears the saved token, with one last channel message that tells Claude the session ended. The server stays up: `reply` leaves the tool list (`notifications/tools/list_changed`), and every tool answers that the session ended and how to reconnect (`connect`, approve, restart Claude Code), never personal-token advice.

- In channel mode the folder's saved session wins: a personal access token in `BUILDIT_TOKEN` (from the usual setup) is ignored with a log note, and only a session token there is used; the deployment `connect` saved is used unless `--api-url` is given, over `BUILDIT_API_URL`.

### Commands

- `buildit-mcp connect --project <KEY> [--label <name>] [--folder <path>] [--api-url <url>]` connects a folder with a device code that you approve in the app, and saves the session token (`buildit_ags_...`) in the OS keychain: Windows Credential Manager, the macOS Keychain or the Secret Service, through the optional `@napi-rs/keyring` package. Without a usable keychain it uses a file readable only by you, and says so (`BUILDIT_TOKEN_STORE=file` picks the file). Once approved, it names the agent, its owner and the org and asks "Is this you? [y/N]": only `y` saves the token, since whoever approves a code gets the session; any other answer cancels the session at once. The projects shown are the ones approved. `--yes` skips the question, for scripts only. A short rate limit on starting is waited out once; a longer one is explained (too many codes waiting from your network, too many started this hour).
- `connect` ends by printing the `claude mcp add` line for the folder, as `connect` itself was run (npx, or a local build). `status` and `disconnect` use the deployment `connect` saved unless `--api-url` is given.
- `buildit-mcp status` shows the folder's session; `buildit-mcp disconnect` cancels it (`DELETE /v1/session`) and forgets its token.

### Other

- `whoami` says whether the token is a personal access token or an agent session (`token.kind`), and shows the session's label.
- Logs scrub session tokens as well as personal access tokens; gitleaks catches session tokens.
- Rate-limit errors name the session and connect limits.

## [0.3.0] - 2026-10-23

Built on version 1.4.0 of the agent API's contract. `list_pins` and `list_emoji` need a buildIt.Social server that serves them, and are refused with a clear message on an older one; `read_channel` and `read_thread` need API 1.3.0 or newer.

### Tools

- `list_pins` (chat toolset): a channel's pinned messages, newest pinned first, with when and by whom each was pinned. Never direct messages; agents can't pin or unpin.
- `list_emoji` (chat toolset): the org's custom emoji by name, which messages and comments show as `:name:`. No images; agents can't add, rename or remove emoji. 43 tools in all.
- `read_channel` and `read_thread` say whether each message is pinned (`pinned`, `pinned_at`, `pinned_by`).

### Docs

- Set clients up with `npx -y @kammcs/buildit-mcp@latest`, not `@0`: npx keeps the copy it first installed for a version range and never updates it, so `@0` stayed on 0.1.0 after 0.2.0 shipped.

## [0.2.0] - 2026-10-22

Built on version 1.2.0 of the agent API's contract; each addition needs a buildIt.Social server that serves it, and is refused with a clear message on an older one.

### Tools

- `search_pages` (pages toolset): pages whose title or body match every word, best first, across the channels you're in or the ones named, with a wrapped snippet and the channel. 41 tools in all.
- `find_users` without `project` finds the org's people the token reaches (for `create_channel`'s members and the like); with `project`, its members as before.
- `search_items` filters by links (`has_link`, such as `blocked_by:open`) and by activity (`activity_since`, which counts comments, unlike `updated_since`), and returns each item's `link_counts` and `activity_at`.
- `whoami` says whether the org is a test org (`org.test`), for eval runners.

## [0.1.0] - 2026-10-22

The first release on npm, as `@kammcs/buildit-mcp`. Built on version 1 of the buildIt.Social agent API (`/v1`).

### Tools

40 tools in seven toolsets. `items` and `comments` are on by default (15 tools); turn the others on with `BUILDIT_TOOLSETS` or `--toolsets` (`all` for every one). A tool is listed only when the token has all the scopes it needs.

- **items** (13): `whoami`, `list_projects`, `describe_project`, `find_users`, `search_items`, `get_item`, `create_item`, `update_item`, `assign_item`, `transition_item`, `link_items`, `unlink_items`, `rank_item`.
- **comments** (2): `list_comments`, `add_comment`.
- **planning** (5): `list_sprints`, `plan_sprint`, `list_releases`, `plan_release`, `write_release_notes`.
- **pages** (4): `list_pages`, `get_page`, `create_page`, `update_page`.
- **chat** (3, read only, never direct messages): `list_channels`, `read_channel`, `read_thread`.
- **admin** (8): `create_channel`, `create_project`, `get_workflow`, `list_work_types`, `propose_workflow_change`, `propose_work_type_change`, `propose_field_change`, `propose_label_change`.
- **destructive** (5): `propose_delete_item`, `propose_move_item`, `propose_bulk_update`, `propose_archive_status`, and `apply_plan`, which is listed whenever any `propose_*` tool is.

Deleting, moving and bulk-editing items, archiving a status, and changing workflows, work types, fields or labels are always two steps: a `propose_*` tool returns a preview and a plan handle, and `apply_plan` applies it only after the person confirms. `admin` and `destructive` stay off unless you name them.

Also in this release:

- Resources `buildit://items/{key}` and `buildit://pages/{id}`, and the prompts `plan_epic`, `triage` and `standup`.
- People-written content (titles, descriptions, comments, pages, messages, and the names of people, projects, channels and the like) comes back inside `<untrusted_content>` blocks, each with a random id that its closing tag repeats.
- Read-only mode (`BUILDIT_READ_ONLY`) and a list of tools to hide (`BUILDIT_EXCLUDE_TOOLS`).
- JSON logs on stderr that never contain tokens or content.
- `whoami` says what the token can't do and why (a scope it lacks, or project or channel limits that hide `create_channel` and `create_project`), so an agent can tell the person instead of looking for a tool.
- The server's instructions no longer ask the agent to call `whoami` before everything (it cost a call in most tasks), and ask it to tell the person about requests aimed at agents that it finds in content, rather than leaving them out of a summary; `get_page`, `read_channel` and `read_thread` say the same where the text is read.
- After `plan_expired` or `plan_stale`, the error, `apply_plan`'s description and the instructions say the new plan needs its own yes: an agent re-proposed an expired deletion and applied it without asking again.
- `get_item` shows the report behind an item that another organization filed through the Feedback app: its kind, severity, plus-ones and state, and the reporter's name, organization and device, wrapped as untrusted content (`source="feedback"`). It says that the agent's comments never reach the reporter.
- `get_item` reads a long description in windows of 20,000 characters (`description_offset`); `detail="full"` points to it when the description is cut.
- `search_items` text searches page with `cursor`, and `query` with `sort` narrows a sorted list to the items matching every word.
- With API 1.1.0's served operations (`/v1/meta`), a call the deployment doesn't serve yet is refused with a clear message instead of a 404, `whoami` lists them (`not_served`), and arguments that need a newer API are refused the same way.
- `plan_release` can correct a release afterwards: `update` (name, description, dates, and the day a released release was released), `reopen` (released back to unreleased, items untouched), `archive` and `restore`. Error hints name these actions.
- `plan_sprint` with `start` lists the sprint's backlog items that moved onto the board, and those that stay, with why.
- `read_channel` and `read_thread` say which messages an app (a bot of the org) sent (`author_type`).
- `server.json` lists the server in the MCP Registry as `io.github.kammcs/buildit-mcp`, with the npm package and the container image.
- A Claude Desktop bundle (`buildit-mcp-<version>.mcpb`, attached to each GitHub release): Claude Desktop keeps the token as a protected setting, with optional settings for the toolsets, read-only mode and the API URL. `npm run bundle` builds it.
- A container image, `ghcr.io/kammcs/buildit-mcp` (amd64 and arm64): HTTP mode on port 8765 by default, a non-root user, a health check on `/healthz`, and no token inside; stdio with `BUILDIT_HTTP=false`.
- [deploy/](deploy/README.md): a Compose file that runs the image behind Caddy for TLS, with the allowed host set from one variable, a read-only filesystem and no capabilities; notes for Fly.io, Cloud Run and other proxies; a checklist.
- `GET /healthz` answers before the `Host` check, so container and platform probes that call it by `localhost` or the instance's address get `200`.
- Image layouts in page bodies and item descriptions: an image's title sets its width (10% to 100%), placement (left, center, right, wrap-left, wrap-right) and gap (`![alt](file:<id> "40% wrap-left gap-m")`); tools that rewrite Markdown keep the titles as read, and a malformed one is refused (`image_layout_invalid`).

### Hardening

- Hardening: untrusted-content blocks carry a random id per result, and the closing tag repeats it; the agent is told a block ends only at its own closing tag.
- Hardening: untrusted-content marking is stronger against look-alike tags, and changes only text that could form a tag: Markdown that mentions the block's name comes back as written.
- Hardening: names that people write (people, the org, tokens, projects, channels, sprints, releases, statuses, types, labels, fields) are inside untrusted blocks in every tool's text, and capped at 64 characters for people and 60 for other names.
- Hardening: in HTTP mode, the configured toolsets are a ceiling; `X-Buildit-Toolsets` can only narrow them.
- Hardening: binding off loopback without `BUILDIT_ALLOWED_HOSTS` is refused unless `BUILDIT_ALLOW_ANY_HOST=true` (or `--allow-any-host`) is set.
- Hardening: path parameters that would change the API route are refused as `invalid_arguments` before any request is sent.
- Hardening: API error text is scrubbed of token-shaped strings, and error details come back inside an untrusted block.
- Hardening: a malformed resource URI is an invalid-params error rather than an internal error.
- Hardening: the API call log records the operation and its path template instead of the filled-in path.

### Transports

- **stdio** (the default): one person, with the token in `BUILDIT_TOKEN`.
- **Streamable HTTP** (`--http`): stateless; every request carries its own `Authorization: Bearer` token and nothing is kept afterwards. It binds to `127.0.0.1` by default, checks the `Host` and `Origin` headers (off loopback, `BUILDIT_ALLOWED_HOSTS` is required unless `BUILDIT_ALLOW_ANY_HOST` is set), lets `X-Buildit-Toolsets` narrow the configured toolsets per request, and answers `GET /healthz`.

### Protocol versions

Both transports serve MCP 2026-07-28 (stateless, with per-request `_meta`) and 2025-11-25 (the initialize handshake).

### Requirements

- Node.js 20 or newer (22 recommended).
- A buildIt.Social personal access token, from an org with agent access turned on.

[0.5.0]: https://github.com/kammcs/buildit-mcp/releases/tag/v0.5.0
[0.4.0]: https://github.com/kammcs/buildit-mcp/releases/tag/v0.4.0
[0.3.0]: https://github.com/kammcs/buildit-mcp/releases/tag/v0.3.0
[0.2.0]: https://github.com/kammcs/buildit-mcp/releases/tag/v0.2.0
[0.1.0]: https://github.com/kammcs/buildit-mcp/releases/tag/v0.1.0
