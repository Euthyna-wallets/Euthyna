#!/bin/sh
# One worker per seller listing. Started with the stack like the rest of the
# services: without a delivery token there is nothing to claim, so it idles
# instead of crash-looping. The token comes from the console (Market -> Rotate
# worker token) and lands in .env, never in this file.
set -eu
if [ -z "${MARKET_DELIVERY_TOKEN:-}" ]; then
  echo '{"event":"worker.idle","reason":"MARKET_DELIVERY_TOKEN is not set"}'
  exec sleep infinity
fi
exec node dist/main.js
