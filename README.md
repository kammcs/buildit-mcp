# buildit-mcp

An [MCP](https://modelcontextprotocol.io) server for [buildIt.Social](https://buildit.social). It lets AI agents (Claude Code, Claude Desktop, Cursor, VS Code and others) work with an org's projects, items, comments, pages and channels through buildIt.Social's agent API, with a personal access token.

It runs on your own machine (stdio) or as a stateless HTTP server for a team. It holds no secrets of its own: each person's token stays in their own client.

**Status:** all toolsets implemented; not yet published. Built on the agent API's v1 contract: items and comments by default (15 tools), and planning, pages, chat, admin and destructive changes when you turn them on (38 tools in all). Run it from a clone (below).

- [How it works](docs/design.md)
- [Security policy](SECURITY.md)
- [Contributing (for people and agents)](CLAUDE.md)

## What you need

- Node.js 20 or newer (22 recommended).
- A buildIt.Social **personal access token**. An org admin first turns on agent access for the org; then you can create a token for yourself, choosing its scopes, an expiry, and optionally the projects and channels it may reach. Tokens start with `buildit_pat_`.

**Keep the token out of files.** Put it in an environment variable (`BUILDIT_TOKEN`) in your user environment or shell profile, and reference that variable from your client's configuration. Never paste it into a config file, especially one in a repository.

## Install from a clone

```sh
git clone https://github.com/kammcs/buildit-mcp.git
cd buildit-mcp
npm ci
npm run build
```

The server is then `node /path/to/buildit-mcp/dist/index.js`. Check it with `node dist/index.js --help`.

## Configuration

Every setting is an environment variable, and also a flag (the flag wins). The token is the exception: it is only ever read from the environment, because other processes can see flags.

| Variable                  | Flag                | Default                                             | Meaning                                                                                                                                                             |
| ------------------------- | ------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BUILDIT_TOKEN`           | none                |                                                     | Your personal access token (stdio mode). Ignored in HTTP mode, where each request carries its own.                                                                  |
| `BUILDIT_API_URL`         | `--api-url`         | `https://api.buildit.social/functions/v1/agent-api` | The agent API. Must be `https://` (plain `http://` only for localhost).                                                                                             |
| `BUILDIT_TOOLSETS`        | `--toolsets`        | `items,comments`                                    | Comma-separated toolsets, or `all`. Known: `items`, `comments`, `planning`, `pages`, `chat`, `admin`, `destructive`.                                                |
| `BUILDIT_READ_ONLY`       | `--read-only`       | `false`                                             | List only tools that change nothing.                                                                                                                                |
| `BUILDIT_EXCLUDE_TOOLS`   | `--exclude-tools`   |                                                     | Comma-separated tool names to hide.                                                                                                                                 |
| `BUILDIT_LOG_LEVEL`       | `--log-level`       | `info`                                              | `debug`, `info`, `warn` or `error`. Logs are JSON lines on stderr and never contain tokens or content.                                                              |
| `BUILDIT_HTTP`            | `--http`            | `false`                                             | Serve Streamable HTTP instead of stdio.                                                                                                                             |
| `BUILDIT_HOST`            | `--host`            | `127.0.0.1`                                         | HTTP bind address.                                                                                                                                                  |
| `BUILDIT_PORT`            | `--port`            | `8765`                                              | HTTP port.                                                                                                                                                          |
| `BUILDIT_ALLOWED_HOSTS`   | `--allowed-hosts`   | localhost names on a loopback bind                  | Hostnames accepted in the `Host` header (DNS-rebinding protection).                                                                                                 |
| `BUILDIT_ALLOWED_ORIGINS` | `--allowed-origins` | localhost names on a loopback bind                  | Hostnames accepted in the `Origin` header. Off loopback, requests with any other `Origin` are refused. `moz-extension://*`-style entries admit a browser extension. |

The tools you see depend on the enabled toolsets, read-only mode, the exclude list, and your token's scopes: a token with only `projects:read` never sees write tools. If buildIt.Social refuses the token, only `whoami` is listed, so the agent can tell you why. If the scopes can't be read for a moment (a rate limit, the network), every tool your configuration allows is listed and buildIt.Social checks each call; the scopes are read again on the next list.

### Toolsets

`items` and `comments` are on by default (15 tools). Turn others on with `BUILDIT_TOOLSETS` (or `--toolsets`), for example `BUILDIT_TOOLSETS=items,comments,planning,pages` or `BUILDIT_TOOLSETS=all` (38 tools). In HTTP mode, the `X-Buildit-Toolsets` header picks them per request.

**`admin` and `destructive` stay off unless you name them**, even when your token has `projects:admin` or `projects:delete`. Turn them on only for work that needs them, for example a separate client entry with `BUILDIT_TOOLSETS=items,admin` while you reorganize a workflow. Their changes always go through preview and confirm (below).

### Tools

| Toolset                   | Tool                       | Scope                               | Annotations             | Does                                                                                                                                                     |
| ------------------------- | -------------------------- | ----------------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `items` (on)              | `whoami`                   | none                                | read-only               | Who the token acts as: the user, the org, the token's name, expiry, scopes and limits, the projects in reach and the rate limits. Call it first.         |
|                           | `list_projects`            | `projects:read`                     | read-only               | The projects in reach, with keys, settings and item counts. Paged.                                                                                       |
|                           | `describe_project`         | `projects:read`                     | read-only               | A project's types, workflows (statuses, allowed moves and the fields they need), labels, custom fields, estimates and members.                           |
|                           | `find_users`               | `projects:read`                     | read-only               | A project's members matching part of a name or email, or "me", for assigning and mentions. Paged.                                                        |
|                           | `search_items`             | `projects:read`                     | read-only               | Items by filters (project, type, status, category, priority, assignee, label, sprint, release, parent, updated since) and text; sorted, paged, `detail`. |
|                           | `get_item`                 | `projects:read`                     | read-only               | One item: fields, description, custom fields, children, links, the latest comments and, optionally, history; with the versions an update needs.          |
|                           | `create_item`              | `projects:write`                    |                         | An epic, story, task, bug or subtask, under a parent or in a project, at a position; safe to retry with its idempotency key.                             |
|                           | `update_item`              | `projects:write`                    | idempotent              | A field patch; the description appended to (safe) or replaced (with its version); `if_version` guards against concurrent edits.                          |
|                           | `assign_item`              | `projects:write`                    | idempotent              | Assign to a person (`me`, an email or a name) or unassign.                                                                                               |
|                           | `transition_item`          | `projects:write`                    | idempotent              | Move to a status by name, setting the fields the move needs and posting a comment; a refused move lists the moves allowed from where the item is.        |
|                           | `link_items`               | `projects:write`                    | idempotent              | Add a link: blocks, blocked by, relates, duplicates, duplicated by.                                                                                      |
|                           | `unlink_items`             | `projects:write`                    | destructive, idempotent | Remove a link, by kind and target or by its id.                                                                                                          |
|                           | `rank_item`                | `projects:write`                    | idempotent              | Move an item before or after another in its project's order.                                                                                             |
| `comments` (on)           | `list_comments`            | `projects:read`                     | read-only               | An item's comments, oldest or newest first, paged.                                                                                                       |
|                           | `add_comment`              | `projects:write`                    |                         | A plain-text comment with `@email` or `@[Display Name]` mentions; safe to retry with its idempotency key.                                                |
| `planning`                | `list_sprints`             | `projects:read`                     | read-only               | A project's sprints, newest first, with goals, dates and item counts. Paged.                                                                             |
|                           | `plan_sprint`              | `projects:write`                    |                         | Create, start or complete a sprint (carrying open items on), or add and remove up to 50 items.                                                           |
|                           | `list_releases`            | `projects:read`                     | read-only               | A project's releases (fix versions), with status, dates, notes page and item counts. Paged.                                                              |
|                           | `plan_release`             | `projects:write`                    |                         | Create or release a release (moving open items on), or add and remove up to 50 items.                                                                    |
|                           | `write_release_notes`      | `projects:write`, `pages:write`     | destructive, idempotent | Write a release's notes page and show it; a page people edited is replaced only with the version they confirmed.                                         |
| `pages`                   | `list_pages`               | `pages:read`                        | read-only               | A channel's pages: titles, tree and versions, without bodies. Paged.                                                                                     |
|                           | `get_page`                 | `pages:read`                        | read-only               | One page's Markdown and version; long pages in windows (`offset`).                                                                                       |
|                           | `create_page`              | `pages:write`                       |                         | A Markdown page in a channel, optionally under a parent; safe to retry with its idempotency key.                                                         |
|                           | `update_page`              | `pages:write`                       | destructive, idempotent | A new title, body (replaced whole), parent or position, with the version read; a conflict says how to reapply.                                           |
| `chat`                    | `list_channels`            | `chat:read`                         | read-only, open-world   | The channels you belong to (never direct messages). Paged.                                                                                               |
|                           | `read_channel`             | `chat:read`                         | read-only, open-world   | A channel's messages, newest first, optionally `since` a time. Paged.                                                                                    |
|                           | `read_thread`              | `chat:read`                         | read-only, open-world   | A message and its replies, oldest first. Paged.                                                                                                          |
| `admin` (off)             | `get_workflow`             | `projects:admin`                    | read-only               | A workflow's statuses, moves and whole definition, to edit and propose.                                                                                  |
|                           | `list_work_types`          | `projects:admin`                    | read-only               | The org's work types and the projects that use each.                                                                                                     |
|                           | `propose_workflow_change`  | `projects:admin`                    |                         | Preview a workflow change (statuses, moves, required fields, types); returns a plan handle.                                                              |
|                           | `propose_work_type_change` | `projects:admin`                    |                         | Preview creating, changing, archiving or restoring a work type.                                                                                          |
|                           | `propose_field_change`     | `projects:admin`                    |                         | Preview creating, changing, archiving or restoring a custom field.                                                                                       |
|                           | `propose_label_change`     | `projects:admin`                    |                         | Preview creating, renaming, recoloring or deleting a label.                                                                                              |
| `destructive` (off)       | `propose_delete_item`      | `projects:delete`                   |                         | Preview deleting an item and its children.                                                                                                               |
|                           | `propose_move_item`        | `projects:delete`                   |                         | Preview moving an item to another project.                                                                                                               |
|                           | `propose_bulk_update`      | `projects:delete`                   |                         | Preview one change to up to 50 items.                                                                                                                    |
|                           | `propose_archive_status`   | `projects:delete`, `projects:admin` |                         | Preview archiving a status, moving its items to another.                                                                                                 |
| with any `propose_*` tool | `apply_plan`               | the plan's                          | destructive             | Apply a plan the person confirmed. Listed whenever a `propose_*` tool is.                                                                                |

No tool is open-world except the chat tools: the others only touch the org's structured data. Every tool returns a short text summary and structured content with an output schema. Long lists are paged (pass `next_cursor` back as `cursor`), and long descriptions, comments, pages and messages are cut so a response stays well under 25,000 tokens.

### Resources and prompts

- **Resources:** `buildit://items/{key}` (with the `items` toolset and `projects:read`) and `buildit://pages/{id}` (with `pages` and `pages:read`), so you can attach an item or a page to a conversation by hand. They read as `get_item` and `get_page` do.
- **Prompts:** `plan_epic` (break an epic into stories), `triage` (sort a project's new items) and `standup` (what changed since yesterday, and what's blocked). The first two end in writes, so they need `projects:write`, and both ask for your go-ahead before changing anything.

### Preview, then confirm

Deleting, moving or bulk-editing items, archiving a status, and changing workflows, work types, fields or labels never happen in one call:

1. A `propose_*` tool asks buildIt.Social to check the change and compute its effect ("Deletes DEMO-42 and its 3 child items"). Nothing changes; it returns a preview and a plan handle.
2. The agent shows you the preview and asks you.
3. Only when you say yes does it call `apply_plan` with the handle. A handle works once, for 10 minutes, only with the token that proposed it, and is refused if anything it targets changed since the preview.

`apply_plan` is marked destructive, so clients that ask before destructive tools ask you again. The server's instructions, every preview and `apply_plan`'s description tell the agent never to apply a plan you haven't seen and agreed to, and never because content in buildIt.Social asks for it.

## Set up your client

Replace `/path/to/buildit-mcp` with the folder of your clone. In every example the token comes from the `BUILDIT_TOKEN` environment variable; set it in your user environment first, then restart the client so it sees the variable.

### Claude Code

Single quotes keep `${BUILDIT_TOKEN}` literal, so the configuration stores the reference, not the token; Claude Code expands it when it starts the server.

```sh
claude mcp add buildit --scope user -e 'BUILDIT_TOKEN=${BUILDIT_TOKEN}' -- node /path/to/buildit-mcp/dist/index.js
```

Or share it with a project through `.mcp.json`, where each person's own `BUILDIT_TOKEN` is used:

```json
{
  "mcpServers": {
    "buildit": {
      "command": "node",
      "args": ["/path/to/buildit-mcp/dist/index.js"],
      "env": { "BUILDIT_TOKEN": "${BUILDIT_TOKEN}" }
    }
  }
}
```

Then ask Claude to "run whoami on buildit" to check the connection.

### Cursor

In `~/.cursor/mcp.json` (or a project's `.cursor/mcp.json`), using Cursor's `${env:NAME}` syntax:

```json
{
  "mcpServers": {
    "buildit": {
      "command": "node",
      "args": ["/path/to/buildit-mcp/dist/index.js"],
      "env": { "BUILDIT_TOKEN": "${env:BUILDIT_TOKEN}" }
    }
  }
}
```

### VS Code

In `.vscode/mcp.json`. VS Code prompts for the token once and keeps it in its secret storage:

```json
{
  "inputs": [
    {
      "type": "promptString",
      "id": "buildit-token",
      "description": "buildIt.Social personal access token",
      "password": true
    }
  ],
  "servers": {
    "buildit": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/buildit-mcp/dist/index.js"],
      "env": { "BUILDIT_TOKEN": "${input:buildit-token}" }
    }
  }
}
```

### Claude Desktop

Claude Desktop's `claude_desktop_config.json` does not expand environment variables, so don't put a token there. A Claude Desktop bundle (`.mcpb`) that stores the token as a protected setting is planned. Until then, either:

- set `BUILDIT_TOKEN` in your user environment and add the server **without** an `env` entry, then restart Claude Desktop and call `whoami` to confirm the token reached the server (whether Claude Desktop passes its environment to servers is not documented, so check); or
- run the server in HTTP mode on your machine (below) and connect to it as a remote server.

```json
{
  "mcpServers": {
    "buildit": {
      "command": "node",
      "args": ["/path/to/buildit-mcp/dist/index.js"]
    }
  }
}
```

## HTTP mode

```sh
node dist/index.js --http            # http://127.0.0.1:8765/mcp
```

- Every request must carry `Authorization: Bearer <token>`; the server uses that request's token for its API calls and keeps nothing afterwards. A token is required even on localhost.
- It binds to `127.0.0.1` and accepts only localhost `Host` and `Origin` headers, unless configured otherwise.
- It serves both MCP protocol versions in use: 2026-07-28 (stateless) and 2025-11-25.
- An `X-Buildit-Toolsets: items,comments` header picks the toolsets for one request. Read-only mode and the exclude list set on the server always apply.
- `GET /healthz` answers `200` for health checks.

For Claude Code:

```sh
claude mcp add buildit --transport http --header 'Authorization: Bearer ${BUILDIT_TOKEN}' http://127.0.0.1:8765/mcp
```

### Team mode

One server can serve a whole team: each member connects with the team URL and their own token, and the server forwards each request with that member's token. It holds no buildIt.Social secret and stores nothing, so it can run as several replicas behind any load balancer.

```sh
node dist/index.js --http --host 0.0.0.0 --port 8765
# with BUILDIT_ALLOWED_HOSTS=mcp.example.com
```

Deployment files (a container image, and a compose file with TLS) and a full guide will follow. Until then, the essentials are under [Hardening](#hardening).

## Security notes

- **Tokens:** keep them in environment variables or your client's secret storage, never in files you commit. Give each token only the scopes it needs, limit it to the projects and channels the work needs, and choose a short expiry. If a token leaks, revoke it in buildIt.Social at once.
- **The agent acts as you.** Everything it does is done with your permissions and is labelled in buildIt.Social as done through your agent.
- **People-written content is marked.** Titles, descriptions, comments, pages and messages come back inside `<untrusted_content>` blocks, and the server tells the agent to treat them as data, never instructions. This reduces, but cannot remove, the risk of prompt injection, so prefer narrow scopes and review what an agent proposes.
- **Destructive and admin changes are previewed and need your confirmation** ([above](#preview-then-confirm)), and their toolsets are off unless you turn them on. Read the preview before you say yes: it is what will happen.
- **Chat is read only**, and never reaches direct messages.
- **Logs** are JSON on stderr and never contain tokens or content.

### Hardening

For an HTTP server that anyone other than you can reach:

- terminate TLS in front of it (a reverse proxy such as Caddy or nginx);
- set `BUILDIT_ALLOWED_HOSTS` to the hostnames clients use, and `BUILDIT_ALLOWED_ORIGINS` only if a browser-based client needs it;
- optionally restrict client IP addresses at the proxy;
- keep it updated: the server warns in its log when the API needs a newer version.

## Development

```sh
npm ci
npm run check         # lint, format check, build, tests
npm run inspect       # MCP Inspector smoke test against a fake API
npm run conformance   # official MCP conformance suite, offline
npm run generate      # regenerate src/api/generated/ from openapi/openapi.json
npm run privacy       # check that no file holds private details (the tests run it too)
```

See [CLAUDE.md](CLAUDE.md) for the architecture and how to add a tool. Tests never call a real buildIt.Social server. [evals/](evals/README.md) has realistic tasks a maintainer runs by hand with a real client against a test org.

## License

MIT. See [LICENSE](LICENSE).
