# syntax=docker/dockerfile:1
#
# buildit-mcp as a container: Streamable HTTP on port 8765 by default, for a
# team server behind a TLS proxy. No token is baked in; each request brings
# its own (Authorization: Bearer ...). Off loopback the server needs
# BUILDIT_ALLOWED_HOSTS (the hostnames clients use) or it refuses to start.
#
#   docker build -t buildit-mcp .
#   docker run -p 8765:8765 -e BUILDIT_ALLOWED_HOSTS=mcp.example.com buildit-mcp
#
# For stdio (a client that starts the container itself):
#   docker run -i --rm -e BUILDIT_HTTP=false -e BUILDIT_TOKEN buildit-mcp

ARG NODE_IMAGE=node:22.23.2-bookworm-slim

FROM ${NODE_IMAGE} AS build
WORKDIR /src
COPY package.json package-lock.json .npmrc ./
RUN npm ci --ignore-scripts --no-audit
COPY tsconfig.json tsconfig.build.json ./
COPY scripts/clean.mjs scripts/
COPY src src
RUN npm run build

FROM ${NODE_IMAGE} AS deps
WORKDIR /src
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev --ignore-scripts --no-audit \
 && find node_modules -mindepth 1 -type d -empty -delete

FROM ${NODE_IMAGE}
ARG VERSION=0.0.0
ARG REVISION=unknown
LABEL org.opencontainers.image.title="buildit-mcp" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.description="MCP server for buildIt.Social's agent API" \
      org.opencontainers.image.source="https://github.com/kammcs/buildit-mcp" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${VERSION}" \
      io.modelcontextprotocol.server.name="io.github.kammcs/buildit-mcp"
ENV NODE_ENV=production \
    BUILDIT_HTTP=true \
    BUILDIT_HOST=0.0.0.0 \
    BUILDIT_PORT=8765
WORKDIR /app
COPY --from=deps /src/package.json ./
COPY --from=deps /src/node_modules node_modules
COPY --from=build /src/dist dist
COPY LICENSE README.md SECURITY.md CHANGELOG.md ./
USER node
EXPOSE 8765
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.BUILDIT_PORT}/healthz`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
ENTRYPOINT ["node", "dist/index.js"]
