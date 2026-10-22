# Run buildit-mcp for a team

One HTTP server can serve a whole team. Each member points their client at the team's URL and sends their own buildIt.Social personal access token with every request; the server forwards each request with that token, so every member acts as themselves with their own permissions.

What that means for running it:

- **It holds no secret.** There is no buildIt.Social credential in the server, its image or its settings. Losing the server exposes only the traffic in flight, which TLS protects.
- **It is stateless.** Nothing about a caller survives a request, so you can run any number of replicas behind any load balancer, with no session affinity. (Each replica keeps each token's scopes for 30 seconds, so listing tools doesn't read them every time; that is a cache, not state.)
- **It must sit behind TLS.** Tokens travel in the `Authorization` header. Never expose it over plain HTTP.

## On a server of your own, with Docker Compose

This folder holds a Compose file that runs the [container image](../README.md#container-image) behind [Caddy](https://caddyserver.com), which gets and renews a TLS certificate for your hostname by itself.

You need a Linux machine with Docker and Compose, a hostname whose DNS points at it (`mcp.example.com` below), and ports 80 and 443 open to it.

```sh
git clone https://github.com/kammcs/buildit-mcp.git
cd buildit-mcp/deploy
cp .env.example .env     # set BUILDIT_MCP_HOST=mcp.example.com, and the toolsets
docker compose up -d
curl https://mcp.example.com/healthz   # {"status":"ok"}
```

Only the folder's three files are needed (`compose.yaml`, `Caddyfile`, `.env`); copy them anywhere if you'd rather not clone. To update, `docker compose pull && docker compose up -d`.

`BUILDIT_MCP_HOST` sets both Caddy's site and the server's `BUILDIT_ALLOWED_HOSTS`, so the `Host` check always matches the name clients use. The server is reachable only through Caddy: its port isn't published on the host. It runs with a read-only filesystem and no Linux capabilities.

## On Fly.io

Fly's proxy terminates TLS and passes the `Host` header through. A `fly.toml` along these lines runs the image (replace the app name, and set the allowed host to the app's hostname or your own domain):

```toml
app = "your-team-buildit-mcp"

[build]
  image = "ghcr.io/kammcs/buildit-mcp:0"

[env]
  BUILDIT_ALLOWED_HOSTS = "your-team-buildit-mcp.fly.dev"
  BUILDIT_TOOLSETS = "items,comments"

[http_service]
  internal_port = 8765
  force_https = true
  auto_stop_machines = "stop"
  auto_start_machines = true

  [[http_service.checks]]
    method = "GET"
    path = "/healthz"
    interval = "30s"
    timeout = "5s"
    grace_period = "10s"
```

Then `fly deploy`. We haven't tested this one ourselves yet; tell us if it needs changes.

## On Google Cloud Run

Cloud Run terminates TLS, and its own probes can call `/healthz`. It deploys images from Artifact Registry, so copy the image there first (or set up an Artifact Registry remote repository for `ghcr.io`), then deploy with the container port set to 8765:

```sh
gcloud run deploy buildit-mcp \
  --image REGION-docker.pkg.dev/PROJECT/REPO/buildit-mcp:0 \
  --port 8765 \
  --allow-unauthenticated \
  --set-env-vars BUILDIT_ALLOWED_HOSTS=buildit-mcp-HASH.REGION.run.app,BUILDIT_TOOLSETS=items,comments
```

`--allow-unauthenticated` lets requests reach the server, which then refuses any without a valid buildIt.Social token. The service's hostname is known after the first deploy: set `BUILDIT_ALLOWED_HOSTS` to it (or to your mapped domain) and deploy again. We haven't tested this one ourselves yet; tell us if it needs changes.

## Behind another proxy

Any TLS-terminating proxy works if it:

- passes the client's `Host` header through (nginx: `proxy_set_header Host $host;`), since the server checks `Host` itself and ignores `X-Forwarded-*` headers;
- doesn't buffer responses, which can be server-sent event streams (nginx: `proxy_buffering off;`);
- allows requests of a few minutes (nginx: `proxy_read_timeout 300s;`).

Then run the server with `BUILDIT_ALLOWED_HOSTS` set to the hostname clients use. If the proxy checks `Host` itself, you can set `BUILDIT_ALLOW_ANY_HOST=true` instead; the server logs a warning when it starts that way.

## Checklist

- TLS in front, always.
- `BUILDIT_ALLOWED_HOSTS` set to the hostnames clients use (the server refuses to start off loopback without it, unless `BUILDIT_ALLOW_ANY_HOST=true`), and `BUILDIT_ALLOWED_ORIGINS` only if a browser-based client needs it.
- Only the toolsets the team needs (`BUILDIT_TOOLSETS`): a request's `X-Buildit-Toolsets` header can narrow them, never add one. `BUILDIT_READ_ONLY=true` for a team that only reads.
- Optionally, restrict client addresses at the proxy (the `Caddyfile` has a commented example).
- Keep it updated: `whoami` says when the API needs a newer version.
- Each member uses their own token with the scopes they need, limited to the projects and channels their work needs, with a short expiry. Never share one token across a team.

Members connect as in [HTTP mode](../README.md#http-mode), with the team URL (`https://mcp.example.com/mcp`) and their own token.
