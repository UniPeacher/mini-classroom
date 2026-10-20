#!/usr/bin/env bash
# 启动微课堂：先启动服务端，就绪后再启动前端（前端要读取服务端实际端口）。
# 首选端口：前端 6101、服务端 6201，被占用时自动顺延。日志与端口记录在 .run/ 下。
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
cd "$ROOT"
mkdir -p "$RUN_DIR"

if [[ ! -d node_modules ]]; then
  echo "缺少依赖，请先运行：pnpm install" >&2
  exit 1
fi

# 等待进程写出端口文件：$1 进程名，$2 超时秒数。进程中途退出时立即失败。
wait_for_port() {
  local name=$1 timeout=$2 i
  for ((i = 0; i < timeout * 10; i++)); do
    [[ -s "$RUN_DIR/$name.port" ]] && return 0
    is_running "$name" || return 1
    sleep 0.1
  done
  return 1
}

# 启动一个进程：$1 进程名，其余为命令
launch() {
  local name=$1
  shift
  if is_running "$name"; then
    echo "$(label_of "$name")已在运行（PID $(cat "$RUN_DIR/$name.pid")）"
    return 0
  fi
  rm -f "$RUN_DIR/$name.port"
  nohup "$@" >"$RUN_DIR/$name.log" 2>&1 &
  echo $! >"$RUN_DIR/$name.pid"
  if ! wait_for_port "$name" 30; then
    echo "$(label_of "$name")启动失败，最近的日志（$RUN_DIR/$name.log）：" >&2
    tail -20 "$RUN_DIR/$name.log" >&2
    exit 1
  fi
}

launch server node --import tsx src/server/main.ts
launch web node node_modules/vite/bin/vite.js

echo "微课堂已启动："
echo "  前端  http://127.0.0.1:$(cat "$RUN_DIR/web.port")"
echo "  服务端 http://127.0.0.1:$(cat "$RUN_DIR/server.port")"
echo "  日志  $RUN_DIR/server.log、$RUN_DIR/web.log"
