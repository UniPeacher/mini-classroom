#!/usr/bin/env bash
# 重启微课堂：停止后重新启动。
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
/bin/bash "$ROOT/stop.sh"
/bin/bash "$ROOT/start.sh"
