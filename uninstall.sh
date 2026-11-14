#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
node cli.js restore
node cli.js status
