#!/bin/sh
set -eu

PORT="${PORT:-8080}"

if ! printf '%s' "$PORT" | grep -Eq '^[0-9]+$'; then
    echo "Invalid PORT '$PORT' (must be a number)" >&2
    exit 1
fi

if [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
    echo "Invalid PORT '$PORT' (must be between 1 and 65535)" >&2
    exit 1
fi

if [ ! -f /etc/caddy/Caddyfile.template ]; then
    echo "Caddyfile.template missing" >&2
    exit 1
fi

sed "s/\${PORT}/${PORT}/g" /etc/caddy/Caddyfile.template > /etc/caddy/Caddyfile

echo "EPUB Reader listening on port ${PORT}"
exec caddy run --config /etc/caddy/Caddyfile --adapter ""
