#!/bin/sh
cd "$(dirname "$0")/.."

npx tsx src/target-app/server.ts &

i=0
until node -e "fetch('http://localhost:4173/login').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"; do
  i=$((i + 1))
  [ "$i" -gt 60 ] && echo "target app did not start" && exit 1
  sleep 1
done

npx tsx src/cli.ts server
