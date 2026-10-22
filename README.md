# buildit-mcp

An [MCP](https://modelcontextprotocol.io) server for [buildIt.Social](https://buildit.social). It lets AI agents (Claude Code, Claude Desktop, Cursor, VS Code and others) work with an org's projects, items, comments, pages and channels through buildIt.Social's agent API, with a personal access token.

It runs on your own machine (stdio) or as a stateless HTTP server for a team. It holds no secrets of its own: each person's token stays in their own client.

**Status:** 0.1.0, the first release, on npm as [`@kammcs/buildit-mcp`](https://www.npmjs.com/package/@kammcs/buildit-mcp). Built on the agent API's v1 contract: items and comments by default (15 tools), and planning, pages, chat, admin and destructive changes when you turn them on (41 tools in all).

- [How it works](docs/design.md)
- [Security policy](SECURITY.md)
- [Changelog](CHANGELOG.md)
- [Contributing (for people and agents)](CLAUDE.md)

## What you need

- Node.js 20 or newer (22 recommended).
- A buildIt.Social **personal access token**. An org admin first turns on agent access for the org (Settings → the org's name → Integrations → Agent access); then you can create a token for yourself in Settings → Agent tokens, choosing its scopes, an expiry, and optionally the projects and channels it may reach. Tokens start with `buildit_pat_`.

**Keep the token out of files.** Put it in an environment variable (`BUILDIT_TOKEN`) in your user environment or shell profile, and reference that variable from your client's configuration. Never paste it into a config file, especially one in a repository.

## Install

Nothing to install by hand: clients start the server with `npx`, which downloads it on first use.

```sh
npx -y @kammcs/buildit-mcp@0 --help
```

- **Versions:** `@0` follows the 0.x releases, so you get fixes and new tools as they ship; `@0.1.0` pins one release. The server tells you when the API needs a newer one ([Versions](#versions)).
- **Windows:** a client that starts `npx` directly fails there (`spawn npx ENOENT`: npx is a `.cmd` file), as Claude Code does. Use `cmd` as the command, with `/c`, `npx`, `-y` and `@kammcs/buildit-mcp@0` as its arguments (the Claude Code example below shows it).
- Also available as a [container image](#container-image) and, for Claude Desktop, as a [bundle](#claude-desktop).

### From a clone (contributors)

```sh
git clone https://github.com/kammcs/buildit-mcp.git
cd buildit-mcp
npm ci
npm run build
```

The server is then `node /path/to/buildit-mcp/dist/index.js`: use that command and argument in place of `npx -y @kammcs/buildit-mcp@0` in the examples below. Inside the clone itself, `npx @kammcs/buildit-mcp` finds the clone's own `package.json` and fails (`buildit-mcp` is not recognized), so a client working in the clone needs `dist/index.js`; with Claude Code, add it there with `--scope local`, which wins over a user-scope entry in that folder only.

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
| `BUILDIT_ALLOWED_HOSTS`   | `--allowed-hosts`   | localhost names on a loopback bind                  | Hostnames accepted in the `Host` header (DNS-rebinding protection). Required when binding off loopback, unless `BUILDIT_ALLOW_ANY_HOST` is set.                     |
| `BUILDIT_ALLOWED_ORIGINS` | `--allowed-origins` | localhost names on a loopback bind                  | Hostnames accepted in the `Origin` header. Off loopback, requests with any other `Origin` are refused. `moz-extension://*`-style entries admit a browser extension. |
| `BUILDIT_ALLOW_ANY_HOST`  | `--allow-any-host`  | `false`                                             | Off loopback, serve without checking the `Host` header (for example behind a proxy that checks it). Without it, such a bind needs `BUILDIT_ALLOWED_HOSTS`.          |

The tools you see depend on the enabled toolsets, read-only mode, the exclude list, and your token's scopes: a token with only `projects:read` never sees write tools, and a token limited to some projects or channels doesn't see `create_channel` and `create_project`. If buildIt.Social refuses the token, only `whoami` is listed, so the agent can tell you why. If the scopes can't be read for a moment (a rate limit, the network), every tool your configuration allows is listed and buildIt.Social checks each call; the scopes are read again on the next list.

### Toolsets

`items` and `comments` are on by default (15 tools). Turn others on with `BUILDIT_TOOLSETS` (or `--toolsets`), for example `BUILDIT_TOOLSETS=items,comments,planning,pages` or `BUILDIT_TOOLSETS=all` (41 tools). In HTTP mode, the `X-Buildit-Toolsets` header picks them per request, among the ones the server enables: it can narrow them, never add one.

**`admin` and `destructive` stay off unless you name them**, even when your token has `projects:admin` or `projects:delete`. Turn them on only for work that needs them, for example a separate client entry with `BUILDIT_TOOLSETS=items,admin` while you reorganize a workflow. Their changes always go through preview and confirm (below), except creating a channel or a project, which changes nothing that exists.

### Tools

| Toolset                   | Tool                       | Scope                               | Annotations             | Does                                                                                                                                                                                                                                       |
| ------------------------- | -------------------------- | ----------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `items` (on)              | `whoami`                   | none                                | read-only               | Who the token acts as: the user, the org, the token's name, expiry, scopes and limits, what it can't do, the projects in reach and the rate limits.                                                                                        |
|                           | `list_projects`            | `projects:read`                     | read-only               | The projects in reach, with keys, settings and item counts. Paged.                                                                                                                                                                         |
|                           | `describe_project`         | `projects:read`                     | read-only               | A project's types, workflows (statuses, allowed moves and the fields they need), labels, custom fields, estimates and members.                                                                                                             |
|                           | `find_users`               | `projects:read`                     | read-only               | A project's members (or, without a project, the org's people) matching part of a name or email, or "me", for assigning and mentions. Paged.                                                                                                |
|                           | `search_items`             | `projects:read`                     | read-only               | Items by filters (project, type, status, category, priority, assignee, label, sprint, release, parent, updated since) links (`has_link`), activity (`activity_since`) and text (best first, or narrowing a sort); sorted, paged, `detail`. |
|                           | `get_item`                 | `projects:read`                     | read-only               | One item: fields, description (long ones in windows), custom fields, children, links, latest comments, a Feedback report and, optionally, history and GitHub refs; the versions an update needs.                                           |
|                           | `create_item`              | `projects:write`                    |                         | An epic, story, task, bug or subtask, under a parent or in a project, at a position; safe to retry with its idempotency key.                                                                                                               |
|                           | `update_item`              | `projects:write`                    | idempotent              | A field patch; the description appended to (safe) or replaced (with its version); `if_version` guards against concurrent edits.                                                                                                            |
|                           | `assign_item`              | `projects:write`                    | idempotent              | Assign to a person (`me`, an email or a name) or unassign.                                                                                                                                                                                 |
|                           | `transition_item`          | `projects:write`                    | idempotent              | Move to a status by name, setting the fields the move needs and posting a comment; a refused move lists the moves allowed from where the item is.                                                                                          |
|                           | `link_items`               | `projects:write`                    | idempotent              | Add a link: blocks, blocked by, relates, duplicates, duplicated by.                                                                                                                                                                        |
|                           | `unlink_items`             | `projects:write`                    | destructive, idempotent | Remove a link, by kind and target or by its id.                                                                                                                                                                                            |
|                           | `rank_item`                | `projects:write`                    | idempotent              | Move an item before or after another in its project's order.                                                                                                                                                                               |
| `comments` (on)           | `list_comments`            | `projects:read`                     | read-only               | An item's comments, oldest or newest first, paged.                                                                                                                                                                                         |
|                           | `add_comment`              | `projects:write`                    |                         | A plain-text comment with `@email` or `@[Display Name]` mentions; safe to retry with its idempotency key.                                                                                                                                  |
| `planning`                | `list_sprints`             | `projects:read`                     | read-only               | A project's sprints, newest first, with goals, dates and item counts. Paged.                                                                                                                                                               |
|                           | `plan_sprint`              | `projects:write`                    |                         | Create, start (moving backlog items onto the board) or complete a sprint (carrying open items on), or add and remove up to 50 items.                                                                                                       |
|                           | `list_releases`            | `projects:read`                     | read-only               | A project's releases (fix versions), with status, dates, notes page and item counts. Paged.                                                                                                                                                |
|                           | `plan_release`             | `projects:write`                    |                         | Create, release, edit, reopen, archive or restore a release (releasing moves open items on), or add and remove up to 50 items.                                                                                                             |
|                           | `write_release_notes`      | `projects:write`, `pages:write`     | destructive, idempotent | Write a release's notes page and show it; a page people edited is replaced only with the version they confirmed.                                                                                                                           |
| `pages`                   | `list_pages`               | `pages:read`                        | read-only               | A channel's pages: titles, tree and versions, without bodies. Paged.                                                                                                                                                                       |
|                           | `search_pages`             | `pages:read`                        | read-only               | Pages whose title or body match words, best first, across your channels, with snippets. Paged.                                                                                                                                             |
|                           | `get_page`                 | `pages:read`                        | read-only               | One page's Markdown and version; long pages in windows (`offset`).                                                                                                                                                                         |
|                           | `create_page`              | `pages:write`                       |                         | A Markdown page in a channel, optionally under a parent; safe to retry with its idempotency key.                                                                                                                                           |
|                           | `update_page`              | `pages:write`                       | destructive, idempotent | A new title, body (replaced whole), parent or position, with the version read; a conflict says how to reapply.                                                                                                                             |
| `chat`                    | `list_channels`            | `chat:read`                         | read-only, open-world   | The channels you belong to (never direct messages). Paged.                                                                                                                                                                                 |
|                           | `read_channel`             | `chat:read`                         | read-only, open-world   | A channel's messages, newest first, optionally `since` a time; says which come from an app (a bot of the org). Paged.                                                                                                                      |
|                           | `read_thread`              | `chat:read`                         | read-only, open-world   | A message and its replies, oldest first. Paged.                                                                                                                                                                                            |
| `admin` (off)             | `create_channel`           | `projects:admin`                    |                         | A public or private channel, with members; safe to retry with its idempotency key. Needs a token without project or channel limits.                                                                                                        |
|                           | `create_project`           | `projects:admin`                    |                         | Turn a channel into a project from a template, with its key (named after the channel); safe to retry. Needs a token without limits and Projects.                                                                                           |
|                           | `get_workflow`             | `projects:admin`                    | read-only               | A workflow's statuses, moves and whole definition, to edit and propose.                                                                                                                                                                    |
|                           | `list_work_types`          | `projects:admin`                    | read-only               | The org's work types and the projects that use each.                                                                                                                                                                                       |
|                           | `propose_workflow_change`  | `projects:admin`                    |                         | Preview a workflow change (statuses, moves, required fields, types); returns a plan handle.                                                                                                                                                |
|                           | `propose_work_type_change` | `projects:admin`                    |                         | Preview creating, changing, archiving or restoring a work type.                                                                                                                                                                            |
|                           | `propose_field_change`     | `projects:admin`                    |                         | Preview creating, changing, archiving or restoring a custom field.                                                                                                                                                                         |
|                           | `propose_label_change`     | `projects:admin`                    |                         | Preview creating, renaming, recoloring or deleting a label.                                                                                                                                                                                |
| `destructive` (off)       | `propose_delete_item`      | `projects:delete`                   |                         | Preview deleting an item and its children.                                                                                                                                                                                                 |
|                           | `propose_move_item`        | `projects:delete`                   |                         | Preview moving an item to another project.                                                                                                                                                                                                 |
|                           | `propose_bulk_update`      | `projects:delete`                   |                         | Preview one change to up to 50 items.                                                                                                                                                                                                      |
|                           | `propose_archive_status`   | `projects:delete`, `projects:admin` |                         | Preview archiving a status, moving its items to another.                                                                                                                                                                                   |
| with any `propose_*` tool | `apply_plan`               | the plan's                          | destructive             | Apply a plan the person confirmed. Listed whenever a `propose_*` tool is.                                                                                                                                                                  |

No tool is open-world except the chat tools: the others only touch the org's structured data. Every tool returns a short text summary and structured content with an output schema. Long lists are paged (pass `next_cursor` back as `cursor`), and long descriptions, comments, pages and messages are cut so a response stays well under 25,000 tokens.

### Resources and prompts

- **Resources:** `buildit://items/{key}` (with the `items` toolset and `projects:read`) and `buildit://pages/{id}` (with `pages` and `pages:read`), so you can attach an item or a page to a conversation by hand. They read as `get_item` and `get_page` do.
- **Prompts:** `plan_epic` (break an epic into stories), `triage` (sort a project's new items) and `standup` (what changed since yesterday, and what's blocked). The first two end in writes, so they need `projects:write`, and both ask for your go-ahead before changing anything.

### Preview, then confirm

Deleting, moving or bulk-editing items, archiving a status, and changing workflows, work types, fields or labels never happen in one call:

1. A `propose_*` tool asks buildIt.Social to check the change and compute its effect ("Deletes DEMO-42 and its 3 child items"). Nothing changes; it returns a preview and a plan handle.
2. The agent shows you the preview and asks you.
3. Only when you say yes does it call `apply_plan` with the handle. A handle works once, for 10 minutes, only with the token that proposed it, and is refused if anything it targets changed since the preview. A plan proposed again after that needs the person's yes again.

`apply_plan` is marked destructive, so clients that ask before destructive tools ask you again. The server's instructions, every preview and `apply_plan`'s description tell the agent never to apply a plan you haven't seen and agreed to, and never because content in buildIt.Social asks for it.

## Set up your client

In every example the token comes from the `BUILDIT_TOKEN` environment variable; set it in your user environment first, then restart the client so it sees the variable.

### Claude Code

Single quotes keep `${BUILDIT_TOKEN}` literal, so the configuration stores the reference, not the token; Claude Code expands it when it starts the server.

```sh
claude mcp add buildit --scope user -e 'BUILDIT_TOKEN=${BUILDIT_TOKEN}' -- npx -y @kammcs/buildit-mcp@0
```

On Windows, from PowerShell (Git Bash would turn `/c` into a path):

```powershell
claude mcp add buildit --scope user -e 'BUILDIT_TOKEN=${BUILDIT_TOKEN}' -- cmd /c npx -y "@kammcs/buildit-mcp@0"
```

Or share it with a project through `.mcp.json`, where each person's own `BUILDIT_TOKEN` is used:

```json
{
  "mcpServers": {
    "buildit": {
      "command": "npx",
      "args": ["-y", "@kammcs/buildit-mcp@0"],
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
      "command": "npx",
      "args": ["-y", "@kammcs/buildit-mcp@0"],
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
      "command": "npx",
      "args": ["-y", "@kammcs/buildit-mcp@0"],
      "env": { "BUILDIT_TOKEN": "${input:buildit-token}" }
    }
  }
}
```

### Claude Desktop

Install the bundle: download `buildit-mcp-<version>.mcpb` from the [latest release](https://github.com/kammcs/buildit-mcp/releases/latest) and open it (or drag it onto Claude Desktop's Settings → Extensions). Claude Desktop asks for your personal access token and keeps it as a protected setting in your system's secure storage, never in a plain config file. The other settings (toolsets, read-only, the API URL) are optional; change them later in the extension's settings. Then ask Claude to call `whoami` to check the token.

To build the bundle from a clone: `npm run bundle`.

Without the bundle, don't put a token in `claude_desktop_config.json`: it doesn't expand environment variables, so the token would sit there in plain text. Instead, either:

- set `BUILDIT_TOKEN` in your user environment and add the server **without** an `env` entry, then restart Claude Desktop and call `whoami` to confirm the token reached the server (whether Claude Desktop passes its environment to servers is not documented, so check); or
- run the server in HTTP mode on your machine (below) and connect to it as a remote server.

```json
{
  "mcpServers": {
    "buildit": {
      "command": "npx",
      "args": ["-y", "@kammcs/buildit-mcp@0"]
    }
  }
}
```

## HTTP mode

```sh
npx -y @kammcs/buildit-mcp@0 --http     # http://127.0.0.1:8765/mcp
```

- Every request must carry `Authorization: Bearer <token>`; the server uses that request's token for its API calls and keeps nothing afterwards. A token is required even on localhost.
- It binds to `127.0.0.1` and accepts only localhost `Host` and `Origin` headers, unless configured otherwise.
- It serves both MCP protocol versions in use: 2026-07-28 (stateless) and 2025-11-25.
- An `X-Buildit-Toolsets: items,comments` header picks the toolsets for one request, among the ones the server enables: the server's toolsets are a ceiling the header can only narrow. For example, a server started with `--toolsets items` lists no `propose_*` tool and no `apply_plan` for a request that asks for `destructive`. Read-only mode and the exclude list set on the server always apply.
- `GET /healthz` answers `200` for health checks.

For Claude Code:

```sh
claude mcp add buildit --transport http --header 'Authorization: Bearer ${BUILDIT_TOKEN}' http://127.0.0.1:8765/mcp
```

### Team mode

One server can serve a whole team: each member connects with the team URL and their own token, and the server forwards each request with that member's token. It holds no buildIt.Social secret and stores nothing, so it can run as several replicas behind any load balancer.

```sh
npx -y @kammcs/buildit-mcp@0 --http --host 0.0.0.0 --port 8765
# with BUILDIT_ALLOWED_HOSTS=mcp.example.com
```

Bound to anything but loopback, the server refuses to start without `BUILDIT_ALLOWED_HOSTS` (the hostnames clients use), so the `Host` header is always checked. If a proxy in front checks it instead, set `BUILDIT_ALLOW_ANY_HOST=true` (or pass `--allow-any-host`) to start anyway; the server then logs a warning.

### Container image

`ghcr.io/kammcs/buildit-mcp` runs the server in HTTP mode on port 8765, as a non-root user, with a health check on `/healthz`. Each release is tagged with its version (`0.1.0`) and its major version (`0`), for amd64 and arm64. No token is in the image: each request brings its own.

```sh
docker run -d -p 8765:8765 -e BUILDIT_ALLOWED_HOSTS=mcp.example.com ghcr.io/kammcs/buildit-mcp:0
```

Every setting under [Configuration](#configuration) works as an environment variable, for example `-e BUILDIT_TOOLSETS=items,comments,planning`. To build the image from a clone instead: `docker build -t buildit-mcp .`.

A client that starts the server itself can run the image over stdio. `-e BUILDIT_TOKEN` without a value passes the token from your environment, so it never appears in the command or the client's config:

```sh
docker run -i --rm -e BUILDIT_HTTP=false -e BUILDIT_TOKEN ghcr.io/kammcs/buildit-mcp:0
```

[deploy/](deploy/README.md) has a Compose file that runs it behind Caddy for TLS, notes for Fly.io, Cloud Run and other proxies, and a checklist. The essentials are under [Hardening](#hardening).

## Security notes

- **Tokens:** keep them in environment variables or your client's secret storage, never in files you commit. Give each token only the scopes it needs, limit it to the projects and channels the work needs, and choose a short expiry. If a token leaks, revoke it in buildIt.Social at once.
- **The agent acts as you.** Everything it does is done with your permissions and is labelled in buildIt.Social as done through your agent.
- **People-written content is marked.** Titles, descriptions, comments, pages and messages, the names of people, projects, channels and the like (and GitHub titles, branch names and authors) come back inside `<untrusted_content>` blocks, and the server tells the agent to treat them as data, never instructions. Each block carries a random id, repeated in its closing tag, and only that closing tag ends it. This reduces, but cannot remove, the risk of prompt injection, so prefer narrow scopes and review what an agent proposes.
- **Destructive and admin changes are previewed and need your confirmation** ([above](#preview-then-confirm)), and their toolsets are off unless you turn them on. Read the preview before you say yes: it is what will happen.
- **Chat is read only**, and never reaches direct messages.
- **Logs** are JSON on stderr and never contain tokens or content.

### Hardening

For an HTTP server that anyone other than you can reach:

- terminate TLS in front of it (a reverse proxy such as Caddy or nginx; [deploy/](deploy/README.md) has a Compose file with Caddy), and don't let the proxy buffer responses, which can be event streams;
- set `BUILDIT_ALLOWED_HOSTS` to the hostnames clients use (required off loopback, unless you set `BUILDIT_ALLOW_ANY_HOST` because the proxy checks the `Host` header), and `BUILDIT_ALLOWED_ORIGINS` only if a browser-based client needs it;
- enable only the toolsets the team needs with `BUILDIT_TOOLSETS`: a request's `X-Buildit-Toolsets` header can narrow them, never add one;
- optionally restrict client IP addresses at the proxy;
- have the proxy pass the client's `Host` header through (Caddy and nginx's `proxy_set_header Host $host` do): the server checks `Host` itself and ignores `X-Forwarded-*` headers, since it never uses the client's address, so there is no trusted-proxies setting;
- keep it updated: `whoami` says when the API needs a newer version ([Versions](#versions)).

## Versions

buildit-mcp follows [semantic versioning](https://semver.org), and every release is listed in [CHANGELOG.md](CHANGELOG.md). Before 1.0, a breaking change raises the minor version (0.1 to 0.2); from 1.0, the major.

- **Tool names are stable.** A released tool keeps its name, and changes to tools are additive: new tools, new optional arguments, new fields in results. Removing or renaming a tool, an argument or a result field is a breaking change.
- **Deprecation comes first.** A tool that is going away is kept for at least one minor version after it is deprecated, still working, with a note at the start of its description that says so and what to use instead, and an entry in the changelog.
- **The API says when to update.** buildIt.Social's agent API publishes the oldest buildit-mcp release it supports (`min_mcp_version`, from `GET /v1/meta`). When this server is older, `whoami` reports `update_required: true` and asks the agent to tell you to update, and in stdio mode the server also logs a warning when it starts. It doesn't stop working by itself: calls go on as far as the API accepts them.
- **The API says what it serves.** From API 1.1.0, `GET /v1/meta` also lists the operations the deployment serves. Once the server has read it (in stdio mode at startup, and whenever `whoami` runs), a call the deployment doesn't serve yet, such as a newer `plan_release` action, is refused with a clear message instead of reaching the API, `whoami` lists those operations (`not_served`), and arguments that need a newer API (such as `description_offset`) are refused the same way.

To update: `npx` with `@0` picks up the newest 0.x release when the client next starts the server (run `npx -y @kammcs/buildit-mcp@0 --version` to check); with a pinned version, change the pin. From a clone, pull and rebuild.

## Development

```sh
npm ci
npm run check         # lint, format check, build, tests, the privacy guard over the packed package
npm run inspect       # MCP Inspector smoke test against a fake API
npm run inspect:docker  # the same, also against the container image (Docker Desktop)
npm run bundle        # build the Claude Desktop bundle (.mcpb) and smoke-test it
npm run conformance   # official MCP conformance suite, offline
npm run generate      # regenerate src/api/generated/ from openapi/openapi.json
npm run privacy       # check that no file holds private details (the tests run it too)
```

See [CLAUDE.md](CLAUDE.md) for the architecture and how to add a tool, and [docs/releasing.md](docs/releasing.md) for how a release ships. Tests never call a real buildIt.Social server. [evals/](evals/README.md) has realistic tasks a maintainer runs by hand with a real client against a test org.

## License

MIT. See [LICENSE](LICENSE).
