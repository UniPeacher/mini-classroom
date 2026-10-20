#!/usr/bin/env bash
# 重启微课堂：停止后重新启动。
set -euo pipefail
DIR="$(dirname "${BASH_SOURCE[0]}")"
/bin/bash "$DIR/stop.sh"
/bin/bash "$DIR/start.sh"
