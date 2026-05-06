#!/bin/bash
# Start the agent with the correct Node version (v24.12.0 from nvm)
# Usage: ./start.sh npm start
#        ./start.sh node src/index.js

NVM_DIR="$HOME/.nvm"
NODE24="$NVM_DIR/versions/node/v24.12.0/bin/node"

# If first arg is "npm", delegate to npm with correct node
if [ "$1" = "npm" ]; then
  shift
  exec "$NODE24" "$NVM_DIR/versions/node/v24.12.0/bin/npm" "$@"
fi

# Otherwise run node directly with args
exec "$NODE24" "$@"
