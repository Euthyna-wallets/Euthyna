# Which Caddyfile serves what

The console image ships a static build plus Caddy; the Caddyfile decides which paths go to the API.
Two files exist and only one is ever active in a given environment.

| File | Used by | Listens on | Notes |
|---|---|---|---|
| `docker/Caddyfile` | local `docker compose up` (baked into the image by the `console` build target) | `:80` | plain HTTP, no certificates |
| `docker/Caddyfile.prod` | the production server, bind-mounted over `/etc/caddy/Caddyfile` by `docker-compose.server.yml` | `euthyna.io` / `www.euthyna.io`, 80 + 443 | Let's Encrypt, `www` → apex redirect |

Both send the same proxy routes (`/near-rpc`, `/api/*`, `/v1/*`, `/health`, `/.well-known/*`, `/a2a/*`)
to `api:3000` and the same cache policy for the single page app:

- `/assets/*` carries a content hash in the file name → `Cache-Control: public, max-age=31536000, immutable`
- everything else, `index.html` first → `Cache-Control: no-cache`, so a returning visitor revalidates
  and never gets the previous build from cache.

## Why the image's Caddyfile is not enough in production

`Dockerfile` copies `docker/Caddyfile` into the image. A rebuild therefore changes what local
`docker compose up` serves, **not** production: the server mounts `docker/Caddyfile.prod` over it.
A cache-header change has to land in `docker/Caddyfile.prod` to reach euthyna.io.

## Deploying the server variant

The server keeps `docker-compose.override.yml` next to its `.env`; the versioned copy is
`docker-compose.server.yml` at the repository root. Copy it as `docker-compose.override.yml` on the
server (compose picks it up automatically) and keep `docker/Caddyfile.prod` in place:

```sh
scp docker/Caddyfile.prod root@host:/opt/mandateos/docker/Caddyfile.server
scp docker-compose.server.yml root@host:/opt/mandateos/docker-compose.override.yml
```

After editing the Caddyfile on the server, validate and reload without dropping the port:

```sh
docker compose exec console caddy validate --config /etc/caddy/Caddyfile
docker compose exec console caddy reload  --config /etc/caddy/Caddyfile
```

`caddy reload` re-reads the bind-mounted file; no image rebuild is needed. This is only true for
production — the local image keeps the Caddyfile baked at build time, so a local edit requires
`docker compose build console`.

