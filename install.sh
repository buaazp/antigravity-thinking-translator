#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
npm run build:renderer >/dev/null
node cli.js check
node cli.js install
node cli.js status
