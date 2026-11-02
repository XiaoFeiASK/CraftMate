#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

OPEN_BROWSER=1
for arg in "$@"; do
  case "$arg" in
    --no-open)
      OPEN_BROWSER=0
      ;;
    -h|--help)
      cat <<'EOF'
用法: ./start.command [--no-open]

启动 CraftMate 本地开发环境：
  - Orchestrator: ws://127.0.0.1:4321/control
  - 管理端:       http://localhost:5173

选项:
  --no-open   不自动打开浏览器
EOF
      exit 0
      ;;
    *)
      echo "未知参数: ${arg}（使用 --help 查看用法）" >&2
      exit 2
      ;;
  esac
done

info() {
  printf '▸ %s\n' "$*"
}

fail() {
  printf '错误: %s\n' "$*" >&2
  exit 1
}

command -v node >/dev/null 2>&1 || fail "未找到 Node.js，请先安装 v22.5 或更高版本。"
command -v npm >/dev/null 2>&1 || fail "未找到 npm，请检查 Node.js 安装。"

NODE_VERSION="$(node -p 'process.versions.node')"
NODE_OK="$(node -p 'const [major, minor] = process.versions.node.split(".").map(Number); major > 22 || (major === 22 && minor >= 5)')"
if [[ "$NODE_OK" != "true" ]]; then
  fail "需要 Node.js >= 22.5，当前是 v${NODE_VERSION}。"
fi

info "Node.js v${NODE_VERSION}"

if [[ ! -d node_modules ]] || [[ package-lock.json -nt node_modules/.package-lock.json ]]; then
  info "安装依赖..."
  npm install --no-audit --no-fund
fi

port_in_use() {
  command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
}

ORCHESTRATOR_PORT="${CRAFTMATE_PORT:-4321}"
if port_in_use "$ORCHESTRATOR_PORT"; then
  fail "端口 ${ORCHESTRATOR_PORT} 已被占用。请停止占用进程，或运行 CRAFTMATE_PORT=4400 ./start.command"
fi
if port_in_use 5173; then
  fail "端口 5173 已被占用。请先停止占用该端口的进程。"
fi

info "Orchestrator: ws://127.0.0.1:${ORCHESTRATOR_PORT}/control"
info "健康检查:     http://127.0.0.1:${ORCHESTRATOR_PORT}/health"
info "管理端:       http://localhost:5173"
info "按 Ctrl+C 停止"

if [[ "$OPEN_BROWSER" == "1" ]] && command -v open >/dev/null 2>&1; then
  (
    for _ in {1..40}; do
      if curl -fsS -o /dev/null --max-time 1 http://localhost:5173/ 2>/dev/null; then
        open "http://localhost:5173" >/dev/null 2>&1 || true
        exit 0
      fi
      sleep 0.5
    done
  ) &
fi

exec npm run dev
