#!/bin/sh
set -e

npx tsx src/target-app/server.ts &

i=0
until node -e "fetch('http://localhost:${TARGET_APP_PORT}/login').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"; do
  i=$((i + 1))
  if [ "$i" -gt 60 ]; then
    echo "target app did not start" >&2
    exit 1
  fi
  sleep 1
done

SERVER_PORT="${PORT}" exec npx tsx src/cli.ts server
