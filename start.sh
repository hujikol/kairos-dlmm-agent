#!/bin/bash
# Ensure correct Node version via nvm before starting the agent
export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1091
\. "$NVM_DIR/nvm.sh" 2>/dev/null || true

# Auto-switch to the version in .nvmrc (e.g. 24.12.0)
nvm use >/dev/null 2>&1 || true

# Fallback: if nvm node is not in PATH, use explicit path
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v)" != "v24"* ]]; then
  NODE24="$HOME/.nvm/versions/node/v24.12.0/bin/node"
  if [ -x "$NODE24" ]; then
    exec "$NODE24" "$@"
  fi
fi

exec node "$@"
