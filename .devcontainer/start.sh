#!/bin/sh
cd "$(dirname "$0")/.."

up() {
  node -e "fetch('$1').then(r => process.exit(r.status < 500 ? 0 : 1), () => process.exit(1))"
}

if up http://localhost:4173/login; then
  echo "Bank app already running on http://localhost:4173"
else
  npx tsx src/target-app/server.ts &
  i=0
  until up http://localhost:4173/login; do
    i=$((i + 1))
    [ "$i" -gt 60 ] && echo "Bank app did not start" && exit 1
    sleep 1
  done
fi

if up http://localhost:4180/api/health; then
  echo "Control center already running on http://localhost:4180"
  wait
else
  npx tsx src/cli.ts server
fi
