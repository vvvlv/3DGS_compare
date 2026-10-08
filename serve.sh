#!/usr/bin/env bash
# Local static server — PLY fetch requires http(s), not file://
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
PORT="${PORT:-8765}"
HOST="${HOST:-127.0.0.1}"
cd "${ROOT}"
echo "3DGS Compare → http://${HOST}:${PORT}/"
exec python3 -m http.server "${PORT}" --bind "${HOST}"
