# The console image as built by docker-compose, with the Caddyfile Fly needs:
# plain HTTP on :80 (Fly terminates TLS) and the API reached over the private network.
FROM mandateos-console:local
COPY fly/console.Caddyfile /etc/caddy/Caddyfile
