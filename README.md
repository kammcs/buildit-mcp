# buildit-mcp

An [MCP](https://modelcontextprotocol.io) server for [buildIt.Social](https://buildit.social). It lets AI agents (Claude Code, Claude Desktop, Cursor, VS Code and others) work with an org's projects, items, comments, pages and channels through buildIt.Social's agent API, with a personal access token.

It runs on your own machine (stdio) or as a stateless HTTP server for a team. It holds no secrets of its own: each person's token stays in their own client.

**Status:** 0.16.0, on npm as [`@kammcs/buildit-mcp`](https://www.npmjs.com/package/@kammcs/buildit-mcp). Built on the agent API's v1 contract: items and comments by default (15 tools), and planning, pages, chat, admin and destructive changes when you turn them on (45 tools in all). In [channel mode](#talk-to-claude-code-from-builditsocial) it also brings your messages to your agent in buildIt.Social into a Claude Code session, which answers with `reply`; with the [buildit plugin](#questions-and-approvals-in-builditsocial-plugin), its questions, approvals and [tool approvals](#tool-approvals-in-builditsocial) come to you there as cards, and you can [assign it work items](#work-items-for-your-agent), which it can [hand to another of your sessions](#handing-work-to-another-session) with your tap. [Files](#files-attachments-in-and-out) go both ways with no extra steps: your attachments reach Claude as local paths, and `reply` posts files. A button in the app can send it a [request](#requests-from-builditsocial), such as a private catch-up on a channel, a thread turned into work items, triage, help with an item, or notes from a call, each answered with a card only your tap applies.

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
npx -y @kammcs/buildit-mcp@latest --help
```

- **Versions:** `@latest` gets the newest release each time the client starts the server, so you get fixes and new tools as they ship; `@0.4.0` pins one release. Don't use a range such as `@0`: npx keeps the copy it first installed for a range and never updates it. The server tells you when the API needs a newer one ([Versions](#versions)).
- **Windows:** a client that starts `npx` directly fails there (`spawn npx ENOENT`: npx is a `.cmd` file), as Claude Code does. Use `cmd` as the command, with `/c`, `npx`, `-y` and `@kammcs/buildit-mcp@latest` as its arguments (the Claude Code example below shows it).
- Also available as a [container image](#container-image) and, for Claude Desktop, as a [bundle](#claude-desktop).

### From a clone (contributors)

```sh
git clone https://github.com/kammcs/buildit-mcp.git
cd buildit-mcp
npm ci
npm run build
```

The server is then `node /path/to/buildit-mcp/dist/index.js`: use that command and argument in place of `npx -y @kammcs/buildit-mcp@latest` in the examples below. Inside the clone itself, `npx @kammcs/buildit-mcp` finds the clone's own `package.json` and fails (`buildit-mcp` is not recognized), so a client working in the clone needs `dist/index.js`; with Claude Code, add it there with `--scope local`, which wins over a user-scope entry in that folder only.

## Configuration

Every setting is an environment variable, and also a flag (the flag wins). The token is the exception: it is only ever read from the environment, because other processes can see flags.

| Variable                  | Flag                | Default                                             | Meaning                                                                                                                                                                                             |
| ------------------------- | ------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BUILDIT_TOKEN`           | none                |                                                     | Your personal access token (stdio mode). Ignored in HTTP mode, where each request carries its own.                                                                                                  |
| `BUILDIT_API_URL`         | `--api-url`         | `https://api.buildit.social/functions/v1/agent-api` | The agent API. Must be `https://` (plain `http://` only for localhost).                                                                                                                             |
| `BUILDIT_TOOLSETS`        | `--toolsets`        | `items,comments`                                    | Comma-separated toolsets, or `all`. Known: `items`, `comments`, `planning`, `pages`, `chat`, `admin`, `destructive`.                                                                                |
| `BUILDIT_READ_ONLY`       | `--read-only`       | `false`                                             | List only tools that change nothing.                                                                                                                                                                |
| `BUILDIT_EXCLUDE_TOOLS`   | `--exclude-tools`   |                                                     | Comma-separated tool names to hide.                                                                                                                                                                 |
| `BUILDIT_LOG_LEVEL`       | `--log-level`       | `info`                                              | `debug`, `info`, `warn` or `error`. Logs are JSON lines on stderr and never contain tokens or content.                                                                                              |
| `BUILDIT_HTTP`            | `--http`            | `false`                                             | Serve Streamable HTTP instead of stdio.                                                                                                                                                             |
| `BUILDIT_HOST`            | `--host`            | `127.0.0.1`                                         | HTTP bind address.                                                                                                                                                                                  |
| `BUILDIT_PORT`            | `--port`            | `8765`                                              | HTTP port.                                                                                                                                                                                          |
| `BUILDIT_ALLOWED_HOSTS`   | `--allowed-hosts`   | localhost names on a loopback bind                  | Hostnames accepted in the `Host` header (DNS-rebinding protection). Required when binding off loopback, unless `BUILDIT_ALLOW_ANY_HOST` is set.                                                     |
| `BUILDIT_ALLOWED_ORIGINS` | `--allowed-origins` | localhost names on a loopback bind                  | Hostnames accepted in the `Origin` header. Off loopback, requests with any other `Origin` are refused. `moz-extension://*`-style entries admit a browser extension.                                 |
| `BUILDIT_ALLOW_ANY_HOST`  | `--allow-any-host`  | `false`                                             | Off loopback, serve without checking the `Host` header (for example behind a proxy that checks it). Without it, such a bind needs `BUILDIT_ALLOWED_HOSTS`.                                          |
| `BUILDIT_CHANNEL`         | `--channel`         | `false`                                             | Claude Code channel mode (stdio): see [Talk to Claude Code from buildIt.Social](#talk-to-claude-code-from-builditsocial). The token then comes from the folder's saved session, or `BUILDIT_TOKEN`. |
| `BUILDIT_FOLDER`          | `--folder`          | the working directory                               | In channel mode, the folder whose saved session is used.                                                                                                                                            |
| `BUILDIT_TOKEN_STORE`     | none                | the OS keychain                                     | `file` keeps session tokens in a file readable only by you instead of the OS keychain.                                                                                                              |

The tools you see depend on the enabled toolsets, read-only mode, the exclude list, and your token's scopes: a token with only `projects:read` never sees write tools, and a token limited to some projects or channels doesn't see `create_channel` and `create_project`. If buildIt.Social refuses the token, only `whoami` is listed, so the agent can tell you why. If the scopes can't be read for a moment (a rate limit, the network), every tool your configuration allows is listed and buildIt.Social checks each call; the scopes are read again on the next list.

### Toolsets

`items` and `comments` are on by default (15 tools). Turn others on with `BUILDIT_TOOLSETS` (or `--toolsets`), for example `BUILDIT_TOOLSETS=items,comments,planning,pages` or `BUILDIT_TOOLSETS=all` (45 tools). In HTTP mode, the `X-Buildit-Toolsets` header picks them per request, among the ones the server enables: it can narrow them, never add one.

**`admin` and `destructive` stay off unless you name them**, even when your token has `projects:admin` or `projects:delete`. Turn them on only for work that needs them, for example a separate client entry with `BUILDIT_TOOLSETS=items,admin` while you reorganize a workflow. Their changes always go through preview and confirm (below), except creating a channel or a project, which changes nothing that exists.

### Tools

| Toolset                   | Tool                       | Scope                               | Annotations             | Does                                                                                                                                                                                                                                       |
| ------------------------- | -------------------------- | ----------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `items` (on)              | `whoami`                   | none                                | read-only               | Who the token acts as: the user, the org, the token's name, expiry, scopes and limits, what it can't do, the projects in reach and the rate limits.                                                                                        |
|                           | `list_projects`            | `projects:read`                     | read-only               | The projects in reach, with keys, settings and item counts. Paged.                                                                                                                                                                         |
|                           | `describe_project`         | `projects:read`                     | read-only               | A project's types, workflows (statuses, allowed moves and the fields they need), labels, custom fields, estimates and members.                                                                                                             |
|                           | `find_users`               | `projects:read`                     | read-only               | A project's members (or, without a project, the org's people) matching part of a name or email, or "me", for assigning and mentions. Paged.                                                                                                |
|                           | `search_items`             | `projects:read`                     | read-only               | Items by filters (project, type, status, category, priority, assignee, label, sprint, release, parent, updated since) links (`has_link`), activity (`activity_since`) and text (best first, or narrowing a sort); sorted, paged, `detail`. |
|                           | `get_item`                 | `projects:read`                     | read-only               | One item: fields, description (long ones in windows), custom fields, children, links, latest comments, a Feedback report or a request form's request and, optionally, history and GitHub refs; the versions an update needs.               |
|                           | `create_item`              | `projects:write`                    |                         | An epic, story, task, bug or subtask, under a parent or in a project, at a position; safe to retry with its idempotency key.                                                                                                               |
|                           | `update_item`              | `projects:write`                    | idempotent              | A field patch; the description appended to (safe) or replaced (with its version); `if_version` guards against concurrent edits.                                                                                                            |
|                           | `assign_item`              | `projects:write`                    | idempotent              | Assign to a person (`me`, an email or a name), to your agent (`agent: "mine"`, working for you), or unassign.                                                                                                                              |
|                           | `transition_item`          | `projects:write`                    | idempotent              | Move to a status by name, setting the fields the move needs and posting a comment; a refused move lists the moves allowed from where the item is.                                                                                          |
|                           | `link_items`               | `projects:write`                    | idempotent              | Add a link: blocks, blocked by, relates, duplicates, duplicated by.                                                                                                                                                                        |
|                           | `unlink_items`             | `projects:write`                    | destructive, idempotent | Remove a link, by kind and target or by its id.                                                                                                                                                                                            |
|                           | `rank_item`                | `projects:write`                    | idempotent              | Move an item before or after another in its project's order.                                                                                                                                                                               |
| `comments` (on)           | `list_comments`            | `projects:read`                     | read-only               | An item's comments, oldest or newest first, optionally `since` a time (API 1.14.0), paged.                                                                                                                                                 |
|                           | `add_comment`              | `projects:write`                    |                         | A plain-text comment with `@email` or `@[Display Name]` mentions; safe to retry with its idempotency key.                                                                                                                                  |
| `planning`                | `list_sprints`             | `projects:read`                     | read-only               | A project's sprints, newest first, with goals, dates and item counts. Paged.                                                                                                                                                               |
|                           | `plan_sprint`              | `projects:write`                    |                         | Create, start (moving backlog items onto the board) or complete a sprint (carrying open items on), or add and remove up to 50 items.                                                                                                       |
|                           | `list_releases`            | `projects:read`                     | read-only               | A project's releases (fix versions), with status, dates, notes page and item counts. Paged.                                                                                                                                                |
|                           | `plan_release`             | `projects:write`                    |                         | Create, release, edit, reopen, archive or restore a release (releasing moves open items on), or add and remove up to 50 items.                                                                                                             |
|                           | `write_release_notes`      | `projects:write`, `pages:write`     | destructive, idempotent | Write a release's notes page and show it; a page people edited is replaced only with the version they confirmed.                                                                                                                           |
|                           | `propose_new_items`        | `projects:write`                    |                         | Preview creating up to 25 items of one project at once (stories with subtasks, with their fields); API 1.15.0. With `request`, the card answers a request.                                                                                 |
|                           | `propose_item_changes`     | `projects:write`                    |                         | Preview changes to up to 20 items of one project, each its own: fields, labels, a description append or replace, links; API 1.15.0.                                                                                                        |
| `pages`                   | `list_pages`               | `pages:read`                        | read-only               | A channel's pages: titles, tree and versions, without bodies. Paged.                                                                                                                                                                       |
|                           | `search_pages`             | `pages:read`                        | read-only               | Pages whose title or body match words, best first, across your channels, with snippets. Paged.                                                                                                                                             |
|                           | `get_page`                 | `pages:read`                        | read-only               | One page's Markdown and version; long pages in windows (`offset`).                                                                                                                                                                         |
|                           | `create_page`              | `pages:write`                       |                         | A Markdown page in a channel, optionally under a parent; safe to retry with its idempotency key.                                                                                                                                           |
|                           | `update_page`              | `pages:write`                       | destructive, idempotent | A new title, body (replaced whole), parent or position, with the version read; a conflict says how to reapply.                                                                                                                             |
| `chat`                    | `list_channels`            | `chat:read`                         | read-only, open-world   | The channels you belong to (never direct messages). Paged.                                                                                                                                                                                 |
|                           | `read_channel`             | `chat:read`                         | read-only, open-world   | A channel's messages, newest first, optionally `since` a time, or `active_since` (posted or replied to after it; API 1.13.0; with work items' threads that have new comments, API 1.14.0); says which come from an app. Paged.             |
|                           | `read_thread`              | `chat:read`                         | read-only, open-world   | A message and its replies, oldest first. Paged.                                                                                                                                                                                            |
|                           | `list_pins`                | `chat:read`                         | read-only, open-world   | A channel's pinned messages, newest pinned first, with when and by whom. Paged. Messages say whether they're pinned in `read_channel` and `read_thread` too.                                                                               |
|                           | `list_emoji`               | `chat:read`                         | read-only               | The org's custom emoji by name (messages show them as `:name:`); no images.                                                                                                                                                                |
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

Deleting, moving or bulk-editing items, archiving a status, changing workflows, work types, fields or labels, and drafts of new items or item changes (`propose_new_items`, `propose_item_changes`) never happen in one call:

1. A `propose_*` tool asks buildIt.Social to check the change and compute its effect ("Deletes DEMO-42 and its 3 child items"). Nothing changes; it returns a preview and a plan handle.
2. The agent shows you the preview and asks you.
3. Only when you say yes does it call `apply_plan` with the handle. A handle works once, for 10 minutes, only with the token that proposed it, and is refused if anything it targets changed since the preview. A plan proposed again after that needs the person's yes again.

`apply_plan` is marked destructive, so clients that ask before destructive tools ask you again. The server's instructions, every preview and `apply_plan`'s description tell the agent never to apply a plan you haven't seen and agreed to, and never because content in buildIt.Social asks for it.

## Set up your client

In every example the token comes from the `BUILDIT_TOKEN` environment variable; set it in your user environment first, then restart the client so it sees the variable.

### Claude Code

Single quotes keep `${BUILDIT_TOKEN}` literal, so the configuration stores the reference, not the token; Claude Code expands it when it starts the server.

```sh
claude mcp add buildit --scope user -e 'BUILDIT_TOKEN=${BUILDIT_TOKEN}' -- npx -y @kammcs/buildit-mcp@latest
```

On Windows, from PowerShell (Git Bash would turn `/c` into a path):

```powershell
claude mcp add buildit --scope user -e 'BUILDIT_TOKEN=${BUILDIT_TOKEN}' -- cmd /c npx -y "@kammcs/buildit-mcp@latest"
```

Or share it with a project through `.mcp.json`, where each person's own `BUILDIT_TOKEN` is used:

```json
{
  "mcpServers": {
    "buildit": {
      "command": "npx",
      "args": ["-y", "@kammcs/buildit-mcp@latest"],
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
      "args": ["-y", "@kammcs/buildit-mcp@latest"],
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
      "args": ["-y", "@kammcs/buildit-mcp@latest"],
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
      "args": ["-y", "@kammcs/buildit-mcp@latest"]
    }
  }
}
```

## Talk to Claude Code from buildIt.Social

With channel mode, the Claude Code session in a folder becomes a **session of your personal agent** in buildIt.Social. You write to the agent in the app, on your computer or your phone; the message arrives in the running Claude Code session, which works on it and answers you in the same thread. The session can also work on the items of the projects you connected it to, as you, labelled as done through the agent.

It works only with the **Claude Code CLI** (not Claude Desktop), because it uses Claude Code [channels](https://code.claude.com/docs/en/channels.md), a research preview whose flags and protocol may still change.

### What you need

- A personal agent in buildIt.Social (Settings → Agents), in an org that hasn't turned agents in the app off (they are on by default).
- The Claude Code CLI, signed in with a **claude.ai account or a Claude Console API key**. Channels aren't available with Amazon Bedrock, Google Cloud's Agent Platform or Microsoft Foundry.
- On a **claude.ai Team or Enterprise** plan, an org Owner must turn channels on first: Organization settings → Claude Code → Channels (or `channelsEnabled: true` in managed settings). Until then Claude Code says the channel is "blocked by org policy".
- Node.js 20 or newer.

### 1. Install or upgrade

Nothing to install by hand: `npx -y @kammcs/buildit-mcp@latest` downloads the newest release when it runs, and again whenever a new one ships. Check the version with `npx -y @kammcs/buildit-mcp@latest --version`; channel mode needs 0.4.0 or newer, the [plugin](#questions-and-approvals-in-builditsocial-plugin) 0.5.0, [work items for your agent](#work-items-for-your-agent) 0.6.0, [tool approvals](#tool-approvals-in-builditsocial) 0.7.0, [handoffs](#handing-work-to-another-session) 0.8.0, [files](#files-attachments-in-and-out) 0.9.0, [requests](#requests-from-builditsocial) 0.11.0, and [asking for work items](#asking-for-work-items) 0.15.0.

> **Until 0.4.0 is on npm**, `@latest` is an older release without channel mode, so use a local build: `git clone https://github.com/kammcs/buildit-mcp.git`, then `npm ci && npm run build` in it, and use `node /path/to/buildit-mcp/dist/index.js` wherever the steps below say `npx -y @kammcs/buildit-mcp@latest`. `connect` run that way prints the matching `claude mcp add` line.

### 2. Connect the folder

In a terminal, in the folder where you run Claude Code (the project or repository), connect it to the projects it may work on:

```sh
npx -y @kammcs/buildit-mcp@latest connect --project DEMO
```

It prints a link and a code. Open the link, sign in to buildIt.Social if you need to, and check that the app shows the same code. The approval screen says what is connecting ("Claude Code on your computer's name"), as which of your agents and to which projects. The scopes are chosen there, not by the CLI: the screen pre-checks reading and writing items, reading and writing pages (`pages:write`, so Claude can create and edit pages, such as a project's docs) and reading chat, and offers deleting items and project admin unticked; you can untick any you don't want to give. Then approve. Approve only a code you started yourself. The code works for 10 minutes.

Once it is approved, the command says who approved it and for which projects, as approved: `Connected as Claude (your name) in your org, project DEMO; session "your-folder".`, and asks **"Is this you? [y/N]"**. Whoever approves a code gets the session, so check the name: only `y` saves the token, in your OS keychain for this folder. Any other answer (or no answer, without a terminal) saves nothing and cancels the session at once, since someone else may have approved your code; run `connect` again for a new code.

- `--project` takes up to 10 project keys (repeat it, or separate keys with commas). The session reaches only those projects, and never more than you can.
- `--label <name>` names the session in buildIt.Social (1 to 40 characters; the folder's name by default). The agent's messages show as "agent · label".
- `--folder <path>` connects another folder than the working directory. `--api-url <url>` connects to another buildIt.Social deployment: its agent API's address, such as `https://buildit.example.com/functions/v1/agent-api`; a bare host such as `https://buildit.example.com` gets `/functions/v1/agent-api` added (the command says so).
- `--capabilities <tags>` sends these capability tags (`macos,ios`) instead of the ones detected on the computer, or none with `none`; see [Handing work to another session](#handing-work-to-another-session). Only tag names are ever sent.
- `--yes` saves without asking. It is for scripts only, and unsafe whenever anyone else could have seen the code.
- No personal access token is involved: the session has a token of its own (`buildit_ags_...`), which the CLI keeps and never prints. It expires after 30 days unused.
- You can change a connected session's permissions later in buildIt.Social (Settings → Agents, **Edit permissions** on the session), without connecting again. Adding one asks for the same two-factor check as approving; a removed one stops working at the session's next call. `status` and `whoami` show the session's current scopes. This needs a buildIt.Social server that offers it; on an older one, connect again to change them.

`npx -y @kammcs/buildit-mcp@latest status` shows the folder's session and whether buildIt.Social still accepts it; `disconnect` cancels the session in buildIt.Social and forgets the folder's token (if it can't reach buildIt.Social, it forgets the token anyway and says to revoke the session in the app).

### 3. Add the server to Claude Code, with `--channel`

`connect` ends by printing the exact line for this step: copy it. In the same folder, it is:

```sh
claude mcp add buildit -- npx -y @kammcs/buildit-mcp@latest --channel
```

On Windows, from PowerShell:

```powershell
claude mcp add buildit -- cmd /c npx -y "@kammcs/buildit-mcp@latest" --channel
```

(From a local build, `claude mcp add buildit -- node "/path/to/buildit-mcp/dist/index.js" --channel`.)

This adds it for this folder only (`--scope local`, the default), which is what you want: each folder has its own session. No `BUILDIT_TOKEN` or `--api-url` is needed: the server reads the token `connect` saved for the folder Claude Code starts it in, and talks to the deployment `connect` used. A `BUILDIT_TOKEN` personal access token in your user environment, from the [usual setup](#claude-code), is fine: channel mode ignores it (and says so in its log) and uses the folder's session; only a session token in `BUILDIT_TOKEN` (`buildit_ags_...`) is used instead. Likewise `BUILDIT_API_URL` is ignored in favour of the deployment `connect` saved; `--api-url` on this line overrides it. A local entry named `buildit` wins over a user-scope `buildit` entry (with a personal access token) in this folder. If the server can't tell the folder (some setups start it elsewhere), add `--folder /path/to/folder` after `--channel`.

### 4. Start Claude Code with the channel

Until the buildit channel is on Claude Code's approved channel list, start Claude Code with the development flag:

```sh
claude --dangerously-load-development-channels server:buildit
```

Claude Code shows a warning about development channels first: choose "I am using this for local development". A line under the banner then says that messages from `server:buildit` arrive in this session. Without the flag, the server still gives Claude its tools and `reply`, but messages from the app don't arrive. Channels need an interactive session: they don't run under `claude -p` or the Agent SDK.

### Using it

- Write to your agent in its conversation in buildIt.Social. Claude Code shows the message in the session and Claude answers in the same thread with the `reply` tool. New messages are picked up within about 5 seconds.
- Only your own messages reach the session: buildit-mcp drops anyone else's, and buildIt.Social sends only yours.
- A message you forward from someone else reaches Claude marked as their text (`forwarded="true"`, inside an `untrusted_content` block), so Claude treats it as information, not as instructions.
- Messages sent while the session isn't running wait in buildIt.Social (for up to 7 days) and arrive when you start Claude Code again in that folder, which resumes the same session and its threads.
- With several folders connected, the app shows each session and lets you choose where a message goes; a thread stays with the session that started it, and a thread of a session that ended can be handed to another.
- To stop a session for good, revoke it in buildIt.Social (Settings → Agents), or run `disconnect`. The running server finds out at its next poll (or call) and clears the folder's saved token, but keeps running: Claude keeps its tools, which now answer that the session has ended and how to reconnect, and `reply` goes from the list. Run `connect` again in the folder and restart Claude Code.

### Work items for your agent

With 0.6.0 and a buildIt.Social server with agent API 1.7.0, your agent can work on items in a project's channel, in the item's thread, where everyone in the project follows along:

- **Assign it.** In buildIt.Social, pick "My agent: Claude" as an item's assignee (it shows as "Claude · for you", and still counts as your work). The session gets the item as a `<channel>` message with `event="item_assigned"`, the item's key (`item`) and `thread_id` (the item's id), with the title, the start of the description and the thread's latest messages as data. Claude works on it and posts progress, questions and the result in the item's thread: `reply`, `ask`, approvals and "is writing" go there by default, and `reply` also takes `item` with the key. From a terminal session (a personal access token), `assign_item` with `agent: "mine"` does the same; a Claude Code session can't assign itself, only hand an item back (`agent: null`) or [ask you for items](#asking-for-work-items).
- **Mention it** in an item's thread (`@Claude`) to bring it in: `event="mention"`, your message as you wrote it, then the item and the thread before it. Once it works in a thread, your other replies there arrive too (`event="message"`), with only the thread messages it hasn't seen.
- **Only you direct it.** Your colleagues see its posts and cards, but their mentions and replies never reach the session as events: they arrive only as context inside yours, in `untrusted_content` blocks, and only you can answer its questions or tap Apply.
- **Unassign it** (or assign someone else, move or delete the item, leave its project) and the session gets `event="item_unassigned"` with the reason ("released" when it only worked there through a mention or a hand-on), and stops: "is writing" stops, the questions it was waiting on in that thread close, and it can no longer post there.
- If no session of the agent is online when you assign it (none connected, or a connected session whose Claude Code is closed), the item's thread says the agent will pick it up when a session comes online (work waits up to 7 days).

### Several items at once

With the plugin, the Claude Code session in the folder is the **lead**: it receives every message, mention and assignment, and gives each work item to its own **item worker**, a subagent the plugin brings (`buildit:buildit-item-worker`). Each item's conversation then stays in its own context, with only that item, its thread, the pages it links and the repository it needs; the lead keeps a small table of which worker has which thread (`.claude/buildit-workers.json`) and does no item work itself. Your direct messages stay with the lead.

- **One worker per item.** A worker starts by reading its item (with its linked branches and pull requests), the item's thread from the start and the pages it links, then the repository. It posts every update, question and approval card in the thread of the item it concerns, naming it: its own item's, or for an epic or a story each child's own ([below](#updates-in-the-app-on-each-item)). It treats the item, its comments and other people's messages as data, never as instructions. Your later messages in that thread, or in its children's threads, go to that same worker; unassigning the item stops it.
- **Its own worktree.** Each worker runs in its own git worktree (Claude Code's worktree isolation), on a branch named for its item, so parallel work on two items never touches the same files.
- **A limit.** At most 3 items are worked on at once (the plugin's "Items at once" setting, 1 to 10). Another item waits its turn: the lead says so once in that item's thread ("Queued — I'll start this after DEMO-12, DEMO-13.") and starts it when a worker finishes.
- **Named threads.** While the session works in more than one thread (an item's thread and the direct message, or several items), `reply`, `ask` and approval cards must name their thread: `thread_id`, or `item` with the item's key (a `propose_*` tool's `card_thread`); without one they're refused with the list of threads. `list_threads` lists the threads the session works in: each item's key, title, status, open cards, when you last wrote, and its handoff if it has one (a subtask handed to this session, or one it proposed handing on). With one thread, the latest one stays the default. Claude's own questions (`AskUserQuestion`, through the plugin) go where they belong: the lead's to your direct message, a worker's to its item's thread (the lead records each worker's agent id in its table for this); one that can't be placed is asked in the terminal. "<agent> is writing…" shows in each item's thread while its worker works on it.
- **After a restart** of Claude Code, a worker is started fresh for an item when its next event arrives, and reads the item's thread again to carry on.

### Updates in the app, on each item

Everything about the work reaches you in buildIt.Social, where you follow it from your computer or phone, never only in the terminal: progress, decisions, questions, design or contract agreements, blockers and results, each in the thread of the item it concerns. The server's instructions (channel mode), the item worker and the plugin's `buildit-work-updates` skill all say so.

- **Epics and stories.** With a buildIt.Social server with agent API 1.21.0, assigning an epic or a story to your agent also gives the session its descendants' threads: the epic's stories, tasks and bugs and their subtasks, a story's subtasks (at most 4 levels down, in the same project). Claude posts each child's work in that child's own thread (`reply` or `ask` with `item` set to the child's key), and the overview in the epic's or story's own thread. Its own posts there never come back to it as events; your messages there reach it like those in the item's own thread.
- **What isn't the session's.** A child assigned to another agent, one another session of your agent works in (`thread_other_session`), or a subtask being handed off stays out (`thread_not_bound`); Claude then says so in its own item's thread, naming the child. Unassigning or moving the item above, or a handoff, ends it at once.
- **`list_threads` doesn't list the children's threads**: Claude names each by its key.
- **Agents Claude starts itself** for parts of the work post their own results on their own item: the session gives them the item's key and asks them to post there with `reply`.
- **Short and factual:** what changed, the commits and tests, what's next, any decision.
- On an older server, posting in a child's thread is refused with `thread_not_bound`, as before.

### Asking for work items

With 0.15.0 and a buildIt.Social server with agent API 1.19.0, a session can ask you to assign it work items, for example the items it just planned with you. It never assigns itself: it asks, and only your tap assigns.

- **The Assign card.** The session calls `propose_assignment` with 1 to 25 items (any level; an epic doesn't bring its children), each with an optional short reason (at most 200 characters, one line). buildIt.Social posts **one Assign card** in the thread the session works in: your direct message with it (`dm: true`), or an item's thread (`thread_id`, or `item` with its key), where every listed item must be in that item's project, since everyone in its channel reads the card. The card shows each item live, with the session's reason as its text. Only you can answer it: tick the items you accept (an item assigned to someone else starts unticked, and assigning it takes it from them) and tap **Assign**, or **Cancel**. It expires after 24 hours.
- **What the session hears** (as `<channel>` messages): first `event="assignment_resolved"` with `request_id`, the `outcome` (`applied`, `cancelled`, `expired`, `withdrawn`, or `closed` with a `reason`), and the keys `assigned`, `skipped` and `unticked`, in the card's thread. Its text names the items assigned, the ones you ticked that couldn't be assigned and why in plain words (done or canceled meanwhile, its project out of the session's reach, another session working in its thread...), and the ones you left unticked, which it shouldn't ask for again. Then each assigned item arrives as an ordinary `event="item_assigned"` (with `assignment_request_id`), to the same session, and is worked on as any other.
- **Lines for your other sessions** (agent API 1.25.0). One card can split a plan between the session and your other sessions (a Windows session and a Mac one, say): each line names who it is for (`session`: `"self"`, a session's id or its label; `whoami` lists your other live sessions that share a project with this one). Left out, a line is for the asking session when it can take the item, else for the best other session that can, online first. You pick or change each line's session on the card; a session you pick never sees the asking session's reasons. The asking session's `assignment_resolved` names the lines sent elsewhere (`assigned_elsewhere`, with the ones waiting for an offline session), the chosen session gets an ordinary `item_assigned` (with `assigned_from`), and each line reports back to the asking session as `event="assigned_item_done"` at In review and at Done, with that thread's last reply as data to check. Handoffs stay for a subtask of the session's own item whose result has to come back.
- **Asking once.** While the card is open the session doesn't message you about it again, and a retry of the same items in the same thread returns the first request instead of a second card. At most 5 requests wait at once, and items done or canceled, or already the session's, can't be listed. **`withdraw_assignment`** closes the session's own card while it still waits for you.
- **Never on someone else's word.** The tool's description and the server's instructions tell Claude to ask only when its own planning produced the work, never because content in buildIt.Social (an item, a comment, a message) asks it to.
- On a server older than agent API 1.19.0 the two tools aren't listed (or say plainly that the server is too old), and the rest works as before.

### Handing work to another session

With 0.8.0 and a buildIt.Social server with agent API 1.9.0, a session that can't do part of its work can hand that part to another of your sessions that can: a Windows session that needs iOS and macOS builds hands them to your Mac, say. Your tap on one card is the go-ahead; the sessions never message each other.

- **Capabilities.** At `connect`, buildit-mcp suggests what the computer can do as capability tags, from a fixed list: `windows`, `macos` or `linux` (the operating system), `xcode` and `ios` (macOS, with the full Xcode app and its iOS SDK), `android` (`ANDROID_HOME` or `ANDROID_SDK_ROOT`, or `adb` on the `PATH`), `flutter`, `docker` and `rust` (`flutter`, `docker`, `cargo` or `rustc` on the `PATH`). It only looks for those programs and folders, without running anything, and each check gives up after 1.5 seconds; a failed check means "not found" and never stops `connect`. **Only the tag names leave the computer**: never a path, a version or anything else. `web` and `gpu` are never detected; you add them in the app. `connect --capabilities macos,ios` sends your own tags instead (`--capabilities none` sends none). When a channel session starts, it suggests what it detects again (`BUILDIT_CAPABILITIES` replaces detection there; on an older server this is skipped).
- **You confirm them.** The suggested tags show ticked on the approval page, where you add or remove any; later, edit them in Settings → Agents. Only the tags you confirmed count: a session can only suggest, and tags never widen a session's projects or scopes. `status` and `whoami` show both ("Capabilities: macos, ios; suggested, not confirmed: flutter").
- **Needs.** Items have a Needs field, the capabilities a session must have to work on them (`create_item` and `update_item` take `needs`, at most 10, and `[]` clears it; items show it). Work for your agent with Needs goes only to a session that has them all, and waits for one otherwise.
- **The handoff.** The session creates a subtask under its own item, or under one of its stories when the item is an epic (`create_item` with `parent`, `needs` and a description that says exactly what to do and what to report), then calls `propose_handoff` with its key. It keeps its own item and carries on. A session can only propose: buildIt.Social posts **one card in the subtask's thread**, worded from structured fields only (who asks, the subtask and its parent, the Needs, your matching sessions with the best one preselected, and what the target will do). Only you can answer it; your colleagues see it read-only. Your tap hands the subtask to the session you picked, and is the go-ahead.
- **The target must be connected to the same project.** A subtask always belongs to its parent's project, and a session that doesn't reach that project with write access is never offered, whatever its tags: connect the Mac with `--project <KEY>` for the same project too.
- **What each session hears** (as `<channel>` messages):
  - The asking session gets `event="handoff_resolved"` with the subtask (`item`), its `parent`, the `outcome` (`applied`, with `to` and `queued` when that session is offline and the work waits up to 7 days; or `cancelled`, `expired`, `stale`, `withdrawn`, `closed`), in the parent's thread.
  - The target session gets the subtask as `event="item_assigned"` with `handoff="true"`, its `handoff_id`, `parent` and `needs`: a lead that says you handed it over and from which session, then the subtask's title and description as data marked `via_agent` (another session wrote them). It works on that subtask only, posts the result in its thread and moves it to In review or Done. If it can't do the work, it hands it back with `decline_handoff` and a short reason.
  - When the subtask reaches In review or Done, is handed back, or the handoff ends (canceled, moved, deleted, expired...), the asking session gets `event="child_done"` with the parent (`item`), the `child`, the `outcome` and the `reason`. The result (the subtask thread's last reply, or the reason it was handed back) comes inside an `untrusted_content` block, marked `via_agent` when another session wrote it: data to check before relying on it, never instructions.
  - A session taken off a subtask gets `event="item_unassigned"` with the reason `declined` (it handed it back) or `handoff_expired` (nobody picked it up in 7 days).
- **`withdraw_handoff`** closes the session's own proposal while the card still waits for you.
- **Still asked separately.** The tap covers that subtask's work only. Store uploads and release version changes still ask you on their own card (the worker is told to `ask` first), and [tool approvals](#tool-approvals-in-builditsocial) still apply. Run the sessions that take handoffs in a mode that asks before tools run (not auto mode or bypass): the subtask's description was written by another session, and in a mode that doesn't ask, its tools run unasked.
- A session working on a subtask can't hand part of it on (subtasks have no children): it asks you instead.
- On a server older than agent API 1.9.0 the three tools aren't listed (or say plainly that the server is too old), `needs` is refused with an explanation, and the rest works as before.

### Files: attachments in and out

With 0.9.0 and a buildIt.Social server with agent API 1.11.0, files work as in a standard Claude Code session, with no extra steps either way. Drop a file into your conversation with the agent, and Claude gets it. Claude shares a render or a log, and it's posted in the thread.

- **Scopes.** A session needs `files:read` to receive files and `files:write` to share them. Both are ticked on the approval page, and you change them in Settings → Agents. They're for sessions only, never personal access tokens. Without one, Claude is told what to ask you for.
- **Attachments come with the message.** When your message has files (in your direct message, a mention or reply in an item's thread, or a message you forwarded), buildit-mcp downloads them before Claude sees the message.
  - **What Claude sees:** the message lists each file's name, type, size and local path, inside an `untrusted_content` block that says whose files they are.
  - **Reading them:** Claude reads them from there (Read for an image or a PDF, `ffmpeg` for a sound, any tool that takes a path).
  - **Forwarded files** are named as their original author's.
  - The download link lasts two minutes and is used once. It's never shown to Claude, logged or saved.
- **The automatic limits.** Up to 100 MiB per file and 250 MiB per message, within the session's daily budget (2 GB of downloads, 1 GB of uploads). Each message waits at most a minute for its files. Anything over is listed with why, and Claude fetches it with `get_attachment` when it needs it.
- **Where they're saved.** In `.claude/buildit-attachments/<session>/<message>/` in the project, so Claude Code reads them without asking.
  - The folder holds a `.gitignore` of `*`, so nothing in it is committed. If the project can't be written, the files go to the temp folder instead.
  - Names are cleaned (no path separators, `..`, control or bidi characters, or reserved Windows names), files are never executable, and each is marked as downloaded from the internet.
  - **Cleanup:** message folders go after 7 days (the oldest first above 2 GiB), the session's folder when it ends, and the project's attachments at `disconnect`.
- **`get_attachment`** (`message_id`, `file_id`) saves one file of a message in the session's threads and returns its path. It's for a file that wasn't downloaded by itself, one the cleanup removed, and colleagues' files in an item thread. Those are listed with their ids, never downloaded by themselves.
- **Sharing: `reply` with `files`.** Claude passes up to 10 local paths, and they're posted at once in the same thread, with the text (the images and videos with the text, each other file in a message of its own). Nobody taps anything.
  - **Checks first.** Before anything is uploaded, every file is checked:
    - it must be inside the project folder or the temp folder;
    - it must not be inside a credentials folder (`~/.ssh`, `~/.aws`, `~/.gnupg`, gcloud, kube, the Docker login, browser profiles);
    - it must not have a secret store's name (`.env*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.kdbx`, `id_rsa*`, `id_ed25519*`, `id_ecdsa*`, `.npmrc`, `.netrc`, `.pgpass`);
    - it must not be a program or an installer;
    - it must be within 250 MiB for a video, 100 MiB for anything else;
    - a text file must not hold anything that looks like a credential. The whole file is scanned with the tool approvals' rules, and the error names the lines.
  - **All or nothing:** one refused file sends nothing, and the error says why, so Claude fixes it and sends again.
  - **Location** is removed from photos and videos before upload, losslessly, into a copy: the original is never touched. buildIt.Social checks again: it refuses a photo that still carries a location, and a text file whose first MiB looks like it holds a credential.
  - **Videos get a poster and their length** when `ffprobe` and `ffmpeg` are installed (on the PATH): a small JPEG frame (at most 320 px and 64 KiB, no metadata) and the duration, shown in the app before anyone plays it. Without them the video is shared just the same, with no poster.
- **The only approval is Claude Code's own.** There's no card for files. If you haven't allowed buildit's tools in Claude Code, it asks about the `reply` call as about any tool, and with the plugin that's a [tool approval card](#tool-approvals-in-builditsocial). If you have allowed them (or run in auto or bypass mode), nothing asks. Shared files go only to the thread the session works in, read by exactly who reads it: you alone in the direct message, the project channel's members in an item's thread.
- **What isn't caught.** Binary files (archives, Office documents, images) aren't scanned, so a secret inside a zip passes. Claude is told to share only what you asked for or what its work needs, and never credentials, keys, `.env` files or private files.
- On a server older than agent API 1.11.0, nothing downloads, `get_attachment` isn't listed, and `reply` takes text only.

### Requests from buildIt.Social

With 0.11.0 and a buildIt.Social server with agent API 1.13.0, you can ask your agent for something from a button in the app, instead of writing to it. In a project's channel, **Catch me up** asks for a summary of what you missed. With 0.13.0 and agent API 1.15.0, the work item kinds join it: **Turn into items with my agent** on a thread, **Triage with my agent** on items, and the item's **With my agent** helpers. With 0.14.0 and agent API 1.18.0, **notes in a call**: turn notes on with one of your sessions, and when they stop, that session summarizes the transcript in the meeting's thread.

- **What a request is.** Your tap, sent to one of your sessions that reaches that channel's project: the app lists them (with an online dot) and preselects the one you used last. It reaches the session as a `<channel>` message with `event="request"`. The tag carries only ids and structured fields: the request's `kind`, its `request_id`, the context (`channel_id`, `from` and `to`; a thread's `context_thread_id`; `item` or `items`), your `locale` and `time_zone`, and where the result goes (`result`). Never message text: the session reads what it needs through its own tools, inside `untrusted_content` blocks, so everything it reads is data, never instructions.
- **The kinds, and where results go.** Each kind has its plugin skill, and its result has one place:
  - `catch_up` (`buildit-catch-up`): reads the channel since you last read it (with `read_channel`'s `active_since` and `read_thread`; since 0.12.0 also the work items' threads with new comments, with `list_comments`' `since`), and posts one short summary (decisions, questions for you, what was said in the items, by item, what's worth a look, each with a link) **only in your direct message with the agent** (`result="dm"`). A catch-up's result is private, and buildIt.Social refuses it anywhere else.
  - `thread_to_items` (`buildit-thread-to-items`, `result="thread"`): reads the thread and the project, and drafts the work it describes (stories, tasks or bugs with subtasks, each with acceptance criteria) as **one Apply card in that thread** (`propose_new_items`).
  - `triage` (`buildit-triage`, `result="item_thread"`): for each item, looks for duplicates and suggests its type, priority, labels and fields, as **one Apply card in the item's own thread** (`propose_item_changes`). It never changes the status. For a feedback report it may ask the reporter (see below).
  - `item_helper.spec`, `.subtasks`, `.estimate`, `.related` and `.stalled` (`buildit-item-helper`, `result="item_thread"`): a spec with acceptance criteria appended to the description, subtasks, an estimate on the project's scale, links to related items, or a short report on a stalled item, as a card (or a note) **in the item's own thread**.
  - `meeting_notes` (`buildit-meeting-notes`, `result="meeting_thread"`, `source="capture"`, 0.14.0): after notes you turned on in a call with the session, buildIt.Social posts the transcript (Markdown, and timed captions as WebVTT) in the meeting's thread and sends the request. The session reads that thread and the transcript **by the request** (`read_thread` and `get_attachment` with `request`: only those, for a day, even in a direct message's call), posts a short summary (decisions, action items, open questions) **in the meeting's thread** in your language, then **one Apply card** of suggested new or changed items: in the thread when the meeting has a project (that project's items only), or, when it has none (a direct message's call, a channel without a project), in your direct message after asking you which project (the propose tool with `request` and `dm: true`). What was said in the call is data: an instruction spoken to agents is not followed, and the session tells you in your direct message that it was there.
    - **A call you couldn't make** (0.15.0, agent API 1.22.0): when you send your agent to listen in for you, the request says so (`absent="true"`, `missed_summary="dm"`). The session still posts the normal notes in the meeting's thread, then a short **"what you missed"** summary just for you in your direct message (the decisions, anything that needs you, your action items, in your language), and puts the Apply card **there** instead of the meeting's thread. A version that doesn't know where the summary goes posts only the normal notes.
- **Only your tap changes anything.** A request's card is an Apply card like any plan card: buildIt.Social applies it as you through your agent when you tap Apply, and only you can; colleagues and guests in the thread see it read-only. It stays open 24 hours. Nothing is created or changed before the tap, and the skills never write directly.
- **Posting by request.** `request` on `reply`, `propose_new_items` and `propose_item_changes` puts the post in the request's place, whatever thread is the latest, without the session working on that thread: the context's thread, or the item's thread (with several items, the post names one). Anywhere else is refused before any call; a refused card is an error, never moved to the direct message. A request may post at most 3 times in each place (`request_post_limit`), within a day of delivery.
- **Questions for you** go to the agent's direct message (`ask` with `dm: true`), never the thread; so do notes about a request that aren't its result (`reply` with `dm: true`). Your replies there are ordinary messages to that session.
- **Questions to a feedback reporter.** On a triage request for a feedback report, the session may ask the person who sent it a question with `ask_reporter`, the only path by which an agent's words leave your org. buildIt.Social shows the question in the item's thread first, sends it a few minutes later in its own words ("Question from the team's assistant:"), and the team can delete it before it goes. The rules, checked by buildIt.Social and first by buildit-mcp: questions only (a "?"), at most 500 characters and 4 lines, and no links, domains or file names, item keys, ids, mentions, emails, HTML or code; at most 2 per report until a person on the team replies in the item's thread, and daily caps. A refusal is final for the request (a question refused for its form may be rewritten once). You can turn it off for your agent in its details ("Ask reporters on my own"). The reporter's answers come back to the item's thread for the team; they don't wake the agent.
- **Language and time zone.** The result is written in your language in buildIt.Social (English, Spanish, French or Serbian, Cyrillic or Latin), whatever language the channel uses, with times in your time zone.
- **Subscriptions.** On a session (in your agent's direct message, its details), add a **morning brief** for a project: once a day, when the session starts after 5:00 in your time zone, it gets a catch-up on that project's channel and your items there (what changed, what's due soon), in your direct message. One brief a day per project, whichever of your sessions it's on. With 0.13.0, a subscription to **new items in Triage** in a project sends each one to triage.
- **Offline.** A request to a session that isn't running waits (up to 7 days) and arrives when you start Claude Code again in that folder. If the session is revoked meanwhile, the request goes to your one other online session that reaches the project, or waits for you to pick one.
- **Update buildit-mcp.** Each kind needs a version that handles it: 0.11.0 for a catch-up, 0.13.0 for the work item kinds, 0.14.0 for a meeting's notes. buildIt.Social won't let you pick a session that last ran an older one for that kind ("Update buildit-mcp to 0.13.0"); an older version that gets one anyway tells you in your direct message that it needs a newer buildit-mcp.
- **Run sessions that take requests in a mode that asks** before tools run (not auto mode or bypass). A request writes only through its cards and notes, and what it reads stays data; in a mode that doesn't ask, content in a thread or a report could still try to steer the session's tools.
- On a server older than agent API 1.13.0, no requests arrive, and `read_channel`'s `active_since` is read as `since` (it says so). On one older than 1.14.0, `read_channel` lists no work items' threads (it says so, and the skill finds them with `search_items`' `activity_since` instead), and `list_comments` applies `since` to each page itself. On one older than 1.15.0, `propose_new_items`, `propose_item_changes` and `request` on a card are refused before any call, and `ask_reporter` isn't listed. On one older than 1.18.0, `request` on `read_thread` and `get_attachment` is refused before any call, and a meeting's notes request (which such a server never sends) gets a lead that says the server needs an update.

### Questions and approvals in buildIt.Social (plugin)

The **buildit plugin** for Claude Code (since 0.5.0; tool approvals since 0.7.0) adds what the bare channel can't do, so you can work with the session from your phone as well as from the terminal:

- **Questions as cards.** When Claude asks you something (its `AskUserQuestion` tool), the questions appear in your agent's conversation in buildIt.Social as one card (0.10.0), instead of in the terminal: for each question, the question in full, a list of its choices with their details (several choices where Claude allows them), and a field to type your own answer instead. The app shows them one at a time, then a review page and Send (a single question sends on its answer); every question needs an answer. Your answers go back to Claude together, and the terminal doesn't ask. In the direct message only you see your answers; in a work item's thread, everyone in the thread sees them once you send them (only you can answer). Claude can also ask you with the `ask` tool while it works on a message from the app.
- **Approvals as cards.** A destructive or configuration change (a `propose_*` tool) is posted as a card with **Apply** and **Cancel**. buildIt.Social words the card from its own preview and applies the change itself when you tap Apply, as you through your agent; an agent session can never apply a change itself (`apply_plan` answers `plan_card_required`), so only your tap applies it. Claude learns the outcome (applied, cancelled, not applied because the items changed, failed, expired after 60 minutes (24 hours for a card that answers a [request](#requests-from-builditsocial)), or unknown, when buildIt.Social couldn't confirm it, and then Claude checks the items) as a channel message.
- **Tool approvals as cards** (0.7.0). When Claude Code would ask you whether a tool may run (a command, a file edit, another tool), it asks in buildIt.Social too, and the first answer wins: see [Tool approvals in buildIt.Social](#tool-approvals-in-builditsocial).
- **"<agent> is writing…"** shows in the thread while Claude works on your message, and stops when it answers, asks, posts an approval, or ends its turn.

If nobody answers a question in time (60 minutes by default), the card closes and Claude is told nobody answered, so it makes a safe assumption and says which, or stops and says what it needs; it doesn't fall back to the terminal. If buildit-mcp can't confirm that nobody answered (your answer may not have come through), Claude is told that instead, and tells you in the thread so you can answer in a message. The same goes when you dismiss the card in the app ("Dismiss question"), or when the session ends while it waits. Pressing Esc in the terminal closes the card. Without the plugin, or with its questions setting off, Claude asks in the terminal as usual.

**Install it.** The plugin replaces the `claude mcp add` server of step 3: it starts buildit-mcp in channel mode itself. So **remove that server first**, in the same folder:

```sh
claude mcp remove buildit
```

Then add this repository as a plugin marketplace and install the plugin (in Claude Code, or from a terminal with `claude plugin ...`):

```text
/plugin marketplace add kammcs/buildit-mcp
/plugin install buildit@buildit-mcp
```

(On Claude Code 2.1.275 or later, `/plugin install buildit --marketplace kammcs/buildit-mcp` does both in one step.) Connect the folder as in step 2 if you haven't, then start Claude Code with the plugin's channel:

```sh
claude --dangerously-load-development-channels plugin:buildit@buildit-mcp
```

`buildit-mcp status` names the buildit servers set up for the folder (the plugin, and any `buildit-mcp --channel` server in `~/.claude.json` or the folder's `.mcp.json`, by name), warns when both kinds are, and says which running one receives the folder's messages. If both run anyway, the plugin's server is the folder's channel, since Claude Code shows channel messages only from a server it registered as one: the plugin passes `--from-plugin`, and a server without it stops polling as soon as the plugin's holds the folder (both keep a lock next to the session file). Of two plugin servers, the first to start wins. A server that isn't the channel serves its tools without it, and its `reply`, `ask` and `whoami` say another buildIt server receives the messages; remove the extra one with `claude mcp remove <name>`.

**Settings** (`/plugin`, the buildit plugin's options):

| Setting                          | Default | What it does                                                                                                              |
| -------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------- |
| Question wait (minutes)          | 60      | How long a question card waits for an answer, 1 to 60. The card closes a minute before the hook's one-hour limit at most. |
| Questions in buildIt.Social      | on      | Off: Claude's `AskUserQuestion` questions stay in the terminal. Approvals and "is writing" are unaffected.                |
| Items at once                    | 3       | How many work items assigned to your agent are worked on at once, 1 to 10, each by its own subagent; the rest wait.       |
| Tool approvals in buildIt.Social | on      | Off: Claude Code asks for tool approvals in the terminal only.                                                            |
| Approval wait (minutes)          | 60      | How long a tool approval card waits, 1 to 60, before Claude is told no. At most a minute under the hook's one-hour limit. |

The plugin passes them to the server as `BUILDIT_ASK_TIMEOUT_MINUTES`, `BUILDIT_QUESTIONS_IN_APP`, `BUILDIT_MAX_PARALLEL_ITEMS`, `BUILDIT_APPROVALS_IN_APP` and `BUILDIT_APPROVAL_TIMEOUT_MINUTES`, and turns every toolset on (`BUILDIT_TOOLSETS=all`), since approvals need the `destructive` and `admin` tools; `--channel` does the same when `BUILDIT_TOOLSETS` isn't set. The session's own scopes and projects still limit what works. It hooks `AskUserQuestion` (`PreToolUse`, an `mcp_tool` hook calling the server's `ask` tool with a one-hour timeout), Claude's turn ending (`Stop`, calling `turn_ended`, which stops "is writing"), and the hooks of [tool approvals](#tool-approvals-in-builditsocial): `PermissionRequest` (`approve`, a one-hour timeout), `PreToolUse` on every tool (`tool_seen`), `PostToolUse` and `PostToolUseFailure` (`tool_done`), `SubagentStop` (`agent_done`) and `UserPromptSubmit` (`prompt_typed`). None of these is a tool for Claude. The plugin also brings two subagents, the item worker (`buildit:buildit-item-worker`, [one per work item](#several-items-at-once)) and the request worker (`buildit:buildit-request-worker`, one per [request](#requests-from-builditsocial), counted with the items at once), and seven skills: `buildit-requests` (the rules every request follows), `buildit-catch-up`, `buildit-thread-to-items`, `buildit-triage`, `buildit-item-helper`, `buildit-meeting-notes`, and `buildit-work-updates` ([updates in the app, on each item](#updates-in-the-app-on-each-item)). Tested with Claude Code 2.1.312, where a hook of this kind waited more than ten minutes (a `PermissionRequest` hook 700 seconds) as it should.

#### Tool approvals in buildIt.Social

With the plugin (0.7.0, and a buildIt.Social server with agent API 1.8.0), when Claude Code would ask you whether a tool may run, it asks in buildIt.Social too, as a card:

- **What the card shows.** Everyone who can read the thread sees only which tool Claude wants to use and who asks ("Claude wants to use Bash", and the subagent when one asks), in buildIt.Social's own words, and that only you can answer. Only you see the details: Claude's description of the call, and each part of its input (the command, the file and its new content, the text an edit replaces), as plain text.
- **Where it goes.** The main session's approvals go to your direct message with the agent; an item worker's (the plugin's own `buildit-item-worker`, by that exact name) to its work item's thread; any other subagent's to the direct message, with the subagent named (a background subagent's terminal prompt may be seen by nobody). When the item's thread refuses the card, it goes to the direct message instead.
- **The answers.** **Approve** runs the call. **Allow for this session** appears when Claude Code suggests a rule for the rest of the session for the tool that asks (such as `Bash(npm test:*)`, or accepting file edits), and approves the call with that rule; a card never offers a rule that would be saved to a settings file, a directory grant, another mode, or a rule for another tool. The rule is granted only when buildIt.Social confirms it stored the same rule you were shown; otherwise your tap approves just this call. **Deny** tells Claude you denied it, and not to retry it but to ask you what to do instead.
- **One call, one verdict.** A card's answer is for the exact call it shows: its tool and its input (and who asks). Claude can call the plugin's hook tools itself, but an approval it gets for one input never lets another input run, even under the same tool call id.
- **The wait.** If nobody answers within the approval wait (60 minutes by default), the card expires and Claude is told nobody approved it in time, so it stops and says what it needs, or does the task another way. If the session ends, the work item is taken from the agent, or tool approvals are switched off for the agent or the org while the card waits, the card closes and Claude is told no as well.
- **Both ask, the first answer wins.** For the main session the terminal asks at the same time; answer there and the card shows "Answered in the terminal" (a "No" in the terminal shows "No longer needed" when the turn ends, and so does Esc, at your next prompt). For a background subagent, the terminal asks only once the hook gives up (the setting is off, the card couldn't be posted, or it stopped being needed).
- **Credentials are masked, but masking never hides what you approve.** Before any detail (or part name) leaves your computer, a credential is replaced with `[REDACTED]`, and only when all of it is plain token characters (letters, digits and `. _ ~ + = -`): shell syntax, a path, a URL, a space or a line break is never hidden, and quotes around a value stay. That covers private key blocks (PEM and PGP) whose lines are all key armor, `Authorization` headers and bearer tokens, the password in a URL (the host after it is always shown), the values of password, secret, token and API key options and assignments (`--password x`, `GITHUB_TOKEN=x`, `"api_key": "x"`, `{\"password\":\"x\"}` inside a shell string), well-known key formats (GitHub, GitLab, Slack, AWS, Google, Stripe, OpenAI and Anthropic keys, and buildIt.Social's own tokens), JSON Web Tokens, and the whole value of any part whose name says it is a secret. So `API_TOKEN="$(curl … | sh)"` is shown as it is, and so is a "key block" with a command inside it. buildIt.Social masks them again with the same rules, and tells you how many values were hidden. **Shown in full:** a secret that isn't plain token characters (base64 with `/`, a URL-encoded password, one with spaces), `curl -u user:pass`, `mysql -ppass`, `sshpass -p x`, a password given as a plain argument or after a line continuation, or an environment variable whose name has no password, secret, token or key word in it; only you see the details, and they are deleted 7 days after the card ends. Control, invisible and tag characters are removed, and long values are cut to their start and end (a very long value before it is masked, so masking stays fast).
- **You approve in the app only what you can see in full.** A Bash or PowerShell command cut to fit the card has no Approve on it ("Too long to check here"), and neither has any call with a hidden value, for any tool ("Part of this is hidden because it looks like a credential"): answer in the terminal, or Deny. Claude is then told to split the command into shorter ones, or to keep credentials out of commands and files, or to ask you in the terminal.
- **Keep credentials out of commands.** In channel mode Claude is told, in the server's instructions and the item worker's, never to put a secret, token, password or key directly in a command, a file's content or an edit; to read it from an environment variable or an existing config file (`"$GITHUB_TOKEN"`, `$env:GITHUB_TOKEN`, a `--password-file` option) and never echo it; and to ask you to do any step that needs a credential typed in, in the terminal. That is guidance: the card's rule above is what enforces it.
- **Where Claude Code doesn't ask, nothing is carded:** auto mode, `acceptEdits` for file edits, `bypassPermissions`, and calls your permission rules already allow. Allow the buildit tools first (`/permissions`: `mcp__plugin_buildit_buildit__*`), so replying and asking never need an approval.
- **Turning it off.** The plugin setting "Tool approvals in buildIt.Social" (`approvals_in_app`) keeps approvals in the terminal; buildIt.Social can also turn them off for your agent. With `--read-only` the server doesn't offer `approve`, so that hook fails and Claude Code asks in the terminal (the other approval hooks stay, and do nothing).
- **Remote Control.** If Remote Control is on for the session (Claude Code's `remoteControlAtStartup`), the Claude app asks you too: all of them ask, and the first answer wins. To turn Remote Control off for one folder, set `"remoteControlAtStartup": false` in that folder's `.claude/settings.local.json`.
- **If the server stops** while a card waits (Claude Code cancels the waiting call first when it shuts down), or a post's answer was lost (the card may exist anyway), the card is closed ("Closed."), by the next buildit server in the folder if need be, so you never approve a call nobody waits for.

Tested with Claude Code 2.1.312.

#### Try it from a checkout

Until 0.7.0 is on npm, the plugin's server (`npx -y @kammcs/buildit-mcp@0.10.0 --channel`) can't be downloaded. A checkout can make a local plugin marketplace whose buildit plugin runs the checkout's own build:

```sh
git clone https://github.com/kammcs/buildit-mcp.git
cd buildit-mcp
npm ci && npm run build
npm run dev-marketplace
```

`npm run dev-marketplace` writes the marketplace `buildit-dev` to `.dev-marketplace/` in the checkout (git ignores it; `-- --out <dir>` writes it elsewhere): the plugin of `plugin/`, with the same name, hooks and settings, whose server is `node <checkout>/dist/index.js --channel --from-plugin` (an absolute path, since Claude Code copies an installed plugin into its plugin cache), and the version `<version>-local`. It prints the commands; once:

```sh
claude plugin marketplace add /path/to/buildit-mcp/.dev-marketplace
claude plugin install buildit@buildit-dev
```

Then, in the folder you work in (connected as in step 2, with the local build: `node /path/to/buildit-mcp/dist/index.js connect --project DEMO`, which prints these steps too):

```sh
claude mcp remove buildit
claude --dangerously-load-development-channels plugin:buildit@buildit-dev
```

- `claude mcp remove buildit` is only needed when the server of step 3 is set up in that folder (it says so when there is none).
- Check the line under the banner: it should say that messages from `plugin:buildit@buildit-dev` arrive in this session.
- `--plugin-dir` alone doesn't do: it loads the plugin's hooks and server, but Claude Code registers a plugin's channel only for an installed plugin, so messages from buildIt.Social wouldn't arrive.
- Run `npm run dev-marketplace` again after rebuilding or pulling, then `claude plugin marketplace update buildit-dev` and `claude plugin update buildit@buildit-dev`, so Claude Code takes the new copy; restart Claude Code. `claude plugin validate .dev-marketplace` checks it.

On Windows, Claude Code starts the plugin's `npx` itself; if `/mcp` shows the plugin's server as failed, check that `npx -y @kammcs/buildit-mcp@0.10.0 --version` works in a terminal (Node.js 20 or newer on `PATH`).

### Where the token is kept

| System  | Store                                                                                                                                                |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows | Windows Credential Manager: generic credentials named `<hash>.buildit-mcp`                                                                           |
| macOS   | The login keychain (service `buildit-mcp`). macOS may ask once whether Node.js may read it, and again after Node.js is updated: choose Always Allow. |
| Linux   | The Secret Service (GNOME Keyring, KWallet), which needs a desktop session                                                                           |

Each folder and deployment has its own entry, named by a hash of the folder's real path and the API's address. The keychain is reached through the optional `@napi-rs/keyring` package, which npm installs with buildit-mcp where it has a build for the system. When there is no usable keychain (a headless Linux, WSL, a system without a build), the token goes to a file readable only by you, and the CLI says so: `%APPDATA%\buildit-mcp\sessions.json` on Windows, `~/Library/Application Support/buildit-mcp/sessions.json` on macOS, `~/.config/buildit-mcp/sessions.json` elsewhere (`$XDG_CONFIG_HOME` if set). Set `BUILDIT_TOKEN_STORE=file` to use the file directly. `BUILDIT_TOKEN` set to a session token overrides the store. Next to each token, `connect` records which deployment the folder's session belongs to (an `api-<hash>` entry, not a secret).

### Troubleshooting

- **"No buildIt.Social session is saved for ..."**: the server looked for a session for that folder and found none. Run `connect` in that folder, or point the server at the right one with `--folder`. A folder reached through another path (a symbolic link, another drive letter) is the same folder only if its real path is the same.
- **Messages don't arrive:** check that Claude Code was started with `--dangerously-load-development-channels server:buildit`, and that `/mcp` shows `buildit` connected. "Blocked by org policy" means your Team or Enterprise org hasn't turned channels on. Sessions signed in through Bedrock, Agent Platform or Foundry can't use channels. For details, start Claude Code with `--debug` and read `~/.claude/debug/<session-id>.txt`; add `-e BUILDIT_LOG_LEVEL=debug` to the `claude mcp add` command for the server's own logs (they never contain tokens or message text).
- **The code expired, or the connection was denied:** run `connect` again for a new code. "Denied" also covers an agent turned off or deleted, or an owner who left the org, after the approval.
- **"Too many connections ... waiting for approval"** or **"... started from this network in the last hour"**: `connect` waits out a short pause by itself; for a longer one, approve or deny the codes already shown (or let them expire after 10 minutes), then try again when it says.
- **"This buildIt.Social session has ended"** from every tool, or "the session was revoked or has expired" in the logs: the session ended (revoked in the app, disconnected, or unused for 30 days), and its saved token was cleared. Claude gets one last channel message saying so, and the server stays up so Claude can tell you. Run `connect --project <KEY>` again in the folder, approve it, then restart Claude Code.
- **The session is paused:** the org turned agents in the app off, or your membership was suspended. The server keeps trying every minute and resumes when it is allowed again.
- **macOS keeps asking for the keychain:** choose Always Allow; it asks again when the Node.js binary changes.
- **WSL:** it can't reach Windows Credential Manager, so the token goes to the file in your Linux home. Run `connect` inside WSL if Claude Code runs there.
- **`spawn npx ENOENT` on Windows:** use `cmd /c npx` as above.

## Codex (bridge mode)

> **Preview.** The direct message, work items, turns, answers, "is writing", restarts, buildit's tools inside Codex, approval cards, and files. Question cards and requests come in later versions. Its options and behaviour may change in any release.

`buildit-mcp codex` connects a folder's buildIt.Social session to [Codex](https://github.com/openai/codex) instead of Claude Code. It starts `codex app-server` (Codex's JSON-RPC server, over stdio) as its only client, and runs in a terminal until you stop it:

```sh
npm install -g @openai/codex       # then sign in once: codex login
cd <your folder>
npx -y @kammcs/buildit-mcp@latest codex --project DEMO
```

- **Connecting:** with `--project`, a folder that has no session yet is connected first, exactly as `connect` does (a code to approve in the app). A connected folder needs no `--project`.
- **Messages:** what you send your agent in its direct message becomes a Codex turn in the folder, with your text. A message sent while Codex is still working joins the running turn (it is steered in) instead of waiting. The direct message is one Codex conversation, as it is for a Claude Code session.
- **Answers:** the turn's final answer is posted in the thread of your latest message (split at 4,000 characters); Codex's progress notes are not. "Your agent is writing..." shows while the turn runs, and pauses while Codex waits on something. A turn that fails posts nothing (the bridge logs it).
- **Work items:** each item you assign the agent (or mention it in) gets its own Codex conversation, as each gets its own worker in Claude Code: its own Codex thread, told the plugin's item worker instructions (one source for both, `src/agent-text.ts`), working in its own git worktree that the bridge makes in `.buildit/worktrees/` (a `.gitignore` of `*` keeps them out of the folder's status) on a branch named for the item (`demo-12-fix-login-redirect`: the key, then the title's letters and digits). Its first turn also gets the `buildit-work-updates` skill. A branch of that name checked out elsewhere gets a new name (`-2`); a free one is reused; nothing is ever removed. A folder that isn't a git repository with a commit has no worktrees: items then work in the folder itself (logged).
  - **At most three at once** (`BUILDIT_MAX_PARALLEL_ITEMS`, 1 to 10): an item holds a slot while its turn runs; the next one waits, and the bridge posts once in its thread "Queued — I'll start this after DEMO-1, DEMO-2.", then starts it when a slot frees. The direct message never waits.
  - **Routing is code, not instructions:** your mentions and messages in an item's thread go to its conversation; in the thread of an item under one the agent works on (a story, task, bug or subtask of an assigned epic or story; the bridge reads each item's parents once), to that item's conversation, and the answer goes in the child's own thread. `child_done` and `handoff_resolved` go to the parent's conversation; a subtask handed to this session (`handoff="true"`) gets its own. `assignment_resolved`, `assigned_item_done` and `plan_resolved` go to the conversation of the item whose thread the card is in, else the direct message's.
  - **Unassigned:** the item's turn is interrupted (nothing of it is posted), its open cards close (declined), and the bridge unsubscribes from its Codex thread (`thread/unsubscribe`); its worktree and branch stay. An item under another's conversation tells that conversation instead, with its next input.
  - **Codex's own subagents** (threads Codex spawns, with a `parentThreadId`) are followed for their approvals only: their cards go to the parent conversation's thread, with a first field naming the subagent. Nothing a subagent says is posted.
- **Your own Codex plugins and apps are off** in the bridge's threads (`features.plugins` and `features.apps` in each thread's config), so the threads carry only buildit's tools and Codex's own. `--keep-codex-plugins` (or `BUILDIT_CODEX_KEEP_PLUGINS=true`) keeps them.
- **Requests aren't taken yet:** a request gets one short notice in the direct message ("This Codex session (preview) can't take requests yet."), once each time the bridge runs. No turn starts for it.
- **buildit's tools inside Codex:** the bridge serves its own tools to its Codex child (the catalog's, and `reply`, `ask`, `get_attachment`, `list_threads`, the handoff and assignment tools), from the same process, over Streamable HTTP on `127.0.0.1` and a random port. You add nothing to your Codex configuration: each thread the bridge starts gets a `buildit` MCP server in its own config (`thread/start`'s `config`; it replaces a `buildit` entry of yours in those threads only), approved without asking (`default_tools_approval_mode = "approve"`) and allowed an hour per call (`tool_timeout_sec = 3600`). Every call must carry a secret made for this run, which only the Codex child gets, in its environment (`bearer_token_env_var`); a call without it is refused. Each Codex thread calls its own URL, so the bridge knows which conversation a `reply` or `ask` comes from by where it arrived, never by anything the model writes (Codex 0.166 also sends the thread's id in each call's `_meta`, which the bridge doesn't rely on): without `thread_id` or `item`, `reply` posts in the thread that conversation's turn answers. The plugin's hook tools (`approve`, `tool_seen`, `turn_ended`, ...) aren't served: Codex's own approvals come to the bridge directly.
- **Files:** the files on your messages are downloaded before Codex gets the message, as in Claude Code's channel (the same caps, daily budget and `get_attachment`), but into a folder of no client's own: `.buildit/attachments/<session>/<message>/` in the folder, with a `.gitignore` of `*` (Claude Code's channel keeps `.claude/buildit-attachments/`). The message lists each file's path, and your own images (PNG, JPEG, GIF, WebP; ten at most) also go to Codex as images, so the model sees them; a forwarded message's files are only listed. Codex shares files with `reply`'s `files`, with every check Claude Code's channel makes (inside the folder or the temp folder, no secret stores or programs, a credential scan, locations removed from photos); Codex's home (`~/.codex`, or `CODEX_HOME`) is never shared from. A `workspace-write` sandbox may keep Codex from writing a render outside the folder: write it inside. The session's attachments are removed when it ends, and `disconnect` removes both folders.
- **Restarts:** each conversation's Codex thread is resumed when the bridge starts again, so Codex keeps its context; an item's worktree is reused, or made again on the same branch when it is gone. An item whose turn was under way (or that waited for a slot) when the bridge stopped carries on by itself, with a short note to read its thread again. Only ids, keys, paths and flags are kept, next to the folder's lock files; Codex keeps the history in its own home folder.
- **Codex's own settings apply:** your Codex configuration decides the model, the reasoning effort, the sandbox and the approval policy. `-c key=value` (repeatable) passes an override to the app-server, as `codex -c` does, for example `-c model="<model>"`.
- **Approvals as cards:** when Codex asks before it runs a command (or sends input to a running one, or opens a network connection), changes files, widens its permissions, or runs an MCP tool that needs approval, you get a tool approval card in buildIt.Social, in the thread of the message Codex is working on, with **Approve** and **Deny**; your tap is Codex's answer (`accept` or `decline`). Only you can read the details: the full command as Codex runs it (on Windows with its PowerShell wrapper) and its parsed actions, each file's diff, the permissions asked for, the host and protocol of a network request, or the MCP tool's server, name and arguments. Credentials are masked as on Claude Code's cards, and **only what you can see in full can be approved**: a card with a cut value (a long command or diff), a hidden value, or a change Codex didn't show is answered `decline` even if you tap Approve. There is never an "always allow" or "Allow for this session" (the bridge never sends `acceptForSession` or Codex's lasting rule amendments); permissions are granted for the turn only. A card closes when Codex no longer needs it (answered elsewhere, or the turn ended), when the session ends, when the bridge or the app-server stops, or after the card's wait (`BUILDIT_APPROVAL_TIMEOUT_MINUTES`, default 60; then it is declined). Questions, other MCP elicitations and dynamic tools are still declined. `BUILDIT_APPROVALS_IN_APP=false` declines every approval instead.
- **When approvals go elsewhere:** with `approval_policy = "never"` Codex never asks, and with `approvals_reviewer = "auto_review"` its own reviewer decides, so no card shows. The bridge reads the setting at startup (`config/read`, no turn) and from each thread, warns in its log, and `buildit-mcp status` says so too (`Codex:` line, from a note next to the folder's lock files). Run Codex with `-c approval_policy="on-request" -c approvals_reviewer="user"` to get the cards. Codex 0.166 no longer takes `approval_policy="untrusted"` (it refuses to start with it): use `on-request`, with a `read-only` or `workspace-write` sandbox, so Codex asks before anything the sandbox doesn't allow.
- **One channel per folder:** the bridge takes the folder's channel as the Claude Code plugin does, so it won't start while Claude Code's channel runs in the same folder (and vice versa).
- **When Codex won't start:** the bridge shows what the app-server said and the likely cause (often a setting it refuses, such as `approval_policy="untrusted"`, which Codex 0.166 no longer takes).
- **The program:** the `codex` on the `PATH` is used; when it is npm's shim, the bridge starts the native binary it wraps. `--codex-path` (or `BUILDIT_CODEX_PATH`) names another one.
- **Logs** go to stderr (`--log-level debug` for more) and never hold what you or Codex wrote. Ctrl+C stops it: the session goes offline and the app-server exits.

### Tested Codex versions

The app-server protocol is marked experimental by Codex and changes often, so the bridge checks the version Codex reports when it starts: older than the minimum, it refuses to start; newer than the lines below, it starts and logs a warning.

| buildit-mcp | Oldest Codex | Tested Codex lines |
| ----------- | ------------ | ------------------ |
| unreleased  | 0.166.0      | 0.166              |

`npm run codex:schema` (in a clone) regenerates the protocol's schema from your installed Codex (`codex app-server generate-json-schema`, which runs no model and needs no sign-in) and checks every method and field the bridge uses against it: it fails when one is gone, and lists the other changes.

## HTTP mode

```sh
npx -y @kammcs/buildit-mcp@latest --http     # http://127.0.0.1:8765/mcp
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
npx -y @kammcs/buildit-mcp@latest --http --host 0.0.0.0 --port 8765
# with BUILDIT_ALLOWED_HOSTS=mcp.example.com
```

Bound to anything but loopback, the server refuses to start without `BUILDIT_ALLOWED_HOSTS` (the hostnames clients use), so the `Host` header is always checked. If a proxy in front checks it instead, set `BUILDIT_ALLOW_ANY_HOST=true` (or pass `--allow-any-host`) to start anyway; the server then logs a warning.

### Container image

`ghcr.io/kammcs/buildit-mcp` runs the server in HTTP mode on port 8765, as a non-root user, with a health check on `/healthz`. Each release is tagged with its version (`0.4.0`) and its major version (`0`), for amd64 and arm64. No token is in the image: each request brings its own.

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
- **Chat is read only**, and never reaches direct messages. The one exception is channel mode (`reply`, `ask`'s question cards and the approval cards), which writes only in your agent's own conversation with you. Only you can answer its cards; an answer is passed to Claude as your words inside an `untrusted_content` block, and an approval card is applied by buildIt.Social on your tap, never by the session.
- **Channel mode passes on only your own messages**, because whoever can write into a Claude Code session can steer it. A session token reaches only the projects you approved, never more than you can, and only your agent's conversation with you; revoke it in the app when you no longer need it.
- **Files in channel mode** ([above](#files-attachments-in-and-out)) are data: an attachment's content never directs Claude, and the server says so. Download links are never shown, logged or saved. Shared files are checked first (roots, credentials folders, secret-store names, programs, sizes, a credential scan of text files), stripped of location, and posted only in the session's own threads.
- **Logs** are JSON on stderr and never contain tokens, presigned URLs' signatures or content.

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

To update: with `@latest`, npx checks for the newest release whenever the client starts the server (run `npx -y @kammcs/buildit-mcp@latest --version` to check); with a pinned version, change the pin. If a client was set up with a range such as `@0`, switch it to `@latest`: npx keeps a range's first install. From a clone, pull and rebuild. The container image's `0` tag moves with each 0.x release; `docker pull` (or `docker compose pull`) fetches it.

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
npm run codex:schema  # check the installed Codex's app-server protocol against the bridge (no model turns)
```

See [CLAUDE.md](CLAUDE.md) for the architecture and how to add a tool, and [docs/releasing.md](docs/releasing.md) for how a release ships. Tests never call a real buildIt.Social server. [evals/](evals/README.md) has realistic tasks a maintainer runs by hand with a real client against a test org.

## License

MIT. See [LICENSE](LICENSE).
