# Changelog

All notable changes to buildit-mcp are listed here. The project follows [semantic versioning](https://semver.org); see [Versions](README.md#versions) for what that means for tools.

## [0.1.0] - unreleased

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
- `plan_sprint` with `start` lists the sprint's backlog items that moved onto the board, and those that stay, with why.
- `read_channel` and `read_thread` say which messages an app (a bot of the org) sent (`author_type`).
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
