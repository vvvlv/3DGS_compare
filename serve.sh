#!/usr/bin/env bash
# Local static server — PLY fetch requires http(s), not file://
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
PORT="${PORT:-8765}"
# Do not use $HOST — conda sets HOST=x86_64-conda-linux-gnu.
BIND="${BIND:-127.0.0.1}"
cd "${ROOT}"
echo "3DGS Compare → http://${BIND}:${PORT}/"
exec python3 -m http.server "${PORT}" --bind "${BIND}"
