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
- People-written content (titles, descriptions, comments, pages, messages) comes back inside `<untrusted_content>` blocks.
- Read-only mode (`BUILDIT_READ_ONLY`) and a list of tools to hide (`BUILDIT_EXCLUDE_TOOLS`).
- JSON logs on stderr that never contain tokens or content.
- Image layouts in page bodies and item descriptions: an image's title sets its width (10% to 100%), placement (left, center, right, wrap-left, wrap-right) and gap (`![alt](file:<id> "40% wrap-left gap-m")`); tools that rewrite Markdown keep the titles as read, and a malformed one is refused (`image_layout_invalid`).

### Transports

- **stdio** (the default): one person, with the token in `BUILDIT_TOKEN`.
- **Streamable HTTP** (`--http`): stateless; every request carries its own `Authorization: Bearer` token and nothing is kept afterwards. It binds to `127.0.0.1` by default, checks the `Host` and `Origin` headers, takes the toolsets per request from `X-Buildit-Toolsets`, and answers `GET /healthz`.

### Protocol versions

Both transports serve MCP 2026-07-28 (stateless, with per-request `_meta`) and 2025-11-25 (the initialize handshake).

### Requirements

- Node.js 20 or newer (22 recommended).
- A buildIt.Social personal access token, from an org with agent access turned on.
