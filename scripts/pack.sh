#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "$ROOT/dist"
(cd "$ROOT" && npm pack --ignore-scripts --pack-destination "$ROOT/dist")
(cd "$ROOT/dist" && sha256sum koishi-plugin-atri-journal-dreams-0.4.1-beta.1.tgz > SHA256SUMS)
python3 "$ROOT/scripts/checksums.py"
