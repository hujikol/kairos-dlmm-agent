#!/bin/bash
# Ensure correct Node version via nvm before starting the agent
export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1091
\. "$NVM_DIR/nvm.sh"  # source nvm

# Auto-switch to the version in .nvmrc (e.g. 24.12.0)
nvm use >/dev/null 2>&1

exec node "$@"
