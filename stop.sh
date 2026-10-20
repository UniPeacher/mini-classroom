#!/usr/bin/env bash
# 停止微课堂：先停前端，再停服务端。先发 TERM 让进程正常退出，10 秒内未退出再强制结束。
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_DIR="$ROOT/.run"

# 进程是否在运行：$1 为 server 或 web
is_running() {
  local pid_file="$RUN_DIR/$1.pid"
  [[ -f "$pid_file" ]] && kill -0 "$(cat "$pid_file")" 2>/dev/null
}

label_of() {
  if [[ "$1" == "server" ]]; then echo "服务端"; else echo "前端"; fi
}

stop_one() {
  local name=$1 pid_file="$RUN_DIR/$1.pid" pid i
  if ! is_running "$name"; then
    echo "$(label_of "$name")未在运行"
    rm -f "$pid_file" "$RUN_DIR/$name.port"
    return 0
  fi
  pid=$(cat "$pid_file")
  kill "$pid"
  for ((i = 0; i < 100; i++)); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.1
  done
  if kill -0 "$pid" 2>/dev/null; then
    kill -9 "$pid"
    echo "$(label_of "$name")未能正常退出，已强制结束（PID ${pid}）"
  else
    echo "$(label_of "$name")已停止（PID ${pid}）"
  fi
  rm -f "$pid_file" "$RUN_DIR/$name.port"
}

stop_one web
stop_one server
