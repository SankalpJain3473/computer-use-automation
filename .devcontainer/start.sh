#!/bin/sh
# Starts the bank app and the control center, or reuses them if they're already running.
cd "$(dirname "$0")/.."

up() {
  node -e "fetch('$1').then(r => process.exit(r.status < 500 ? 0 : 1), () => process.exit(1))"
}

url() {
  if [ -n "$CODESPACE_NAME" ]; then
    echo "https://${CODESPACE_NAME}-$1.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-app.github.dev}"
  else
    echo "http://localhost:$1"
  fi
}

if [ ! -d node_modules ]; then
  npm ci
  npx playwright install --with-deps chromium
fi

if up http://localhost:4173/login; then
  echo "Bank app already running."
else
  npx tsx src/target-app/server.ts > /tmp/bank-app.log 2>&1 &
  i=0
  until up http://localhost:4173/login; do
    i=$((i + 1))
    if [ "$i" -gt 60 ]; then
      echo "Bank app did not start:"
      cat /tmp/bank-app.log
      exit 1
    fi
    sleep 1
  done
fi

npx tsx -e "import('./src/server/auth.ts').then((m) => m.loadKeys())"
OPERATOR_KEY=$(node -p "require('./.keys.json').operator")

cat <<EOF

  Bank app        $(url 4173)
                  sign in: teller1 / demo

  Control center  $(url 4180)
                  operator key: ${OPERATOR_KEY}

  The README's "Try it" section lists what to enter.

EOF

if up http://localhost:4180/api/health; then
  echo "Control center already running."
else
  exec npx tsx src/cli.ts server
fi
