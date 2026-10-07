# buildit-mcp

An [MCP](https://modelcontextprotocol.io) server for [buildIt.Social](https://buildit.social). It lets AI agents (Claude Code, Claude Desktop, Cursor, VS Code and others) work with an org's projects, items, comments, pages and channels through buildIt.Social's agent API, with a personal access token.

It runs on your own machine (stdio) or as a stateless HTTP server for a team. It holds no secrets of its own: each person's token stays in their own client.

**Status:** in development, not yet published to npm. This version has the framework and one tool, `whoami`; the item and comment tools come next. Run it from a clone (below).

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

The tools you see depend on the enabled toolsets, read-only mode, the exclude list, and your token's scopes: a token with only `projects:read` never sees write tools.

### Tools

| Toolset              | Tool     | Does                                                                                                                                                                          |
| -------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `items` (on)         | `whoami` | Who the token acts as: the user, the org, the token's name and expiry, its scopes and limits, and the projects in reach. Call it first, or when something fails to authorize. |
| `comments` (on)      |          | Coming next.                                                                                                                                                                  |
| other toolsets (off) |          | Later: planning, pages, chat (read only), admin and destructive changes (both previewed and confirmed).                                                                       |

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
- **People-written content is marked.** Titles, descriptions, comments, pages and messages come back inside `<untrusted_content>` blocks, and the server tells the agent to treat them as data, never instructions. This reduces, but cannot remove, the risk of prompt injection, so prefer narrow scopes and review what an agent proposes. Destructive and admin changes are always previewed and need your confirmation.
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
```

See [CLAUDE.md](CLAUDE.md) for the architecture and how to add a tool. Tests never call a real buildIt.Social server.

## License

MIT. See [LICENSE](LICENSE).
