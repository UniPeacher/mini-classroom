# 启停脚本的公共部分：项目路径、运行时目录、进程判断
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="$ROOT/.run"

# 进程是否在运行：$1 为 server 或 web
is_running() {
  local pid_file="$RUN_DIR/$1.pid"
  [[ -f "$pid_file" ]] && kill -0 "$(cat "$pid_file")" 2>/dev/null
}

label_of() {
  if [[ "$1" == "server" ]]; then echo "服务端"; else echo "前端"; fi
}
