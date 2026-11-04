#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

MODE=desktop
OPEN_BROWSER=1
for arg in "$@"; do
  case "$arg" in
    --web)
      MODE=web
      ;;
    --desktop)
      MODE=desktop
      ;;
    --no-open)
      OPEN_BROWSER=0
      ;;
    -h|--help)
      cat <<'EOF'
用法: ./start.command [--web] [--no-open]

启动 CraftMate 本地桌面应用（默认），同时启动 Orchestrator：
  - Orchestrator: ws://127.0.0.1:4321/control
  - Voice:        ws://127.0.0.1:4323/voice
  - 桌面窗口:     Tauri 原生窗口

选项:
  --web       启动浏览器预览版，不打开桌面窗口
  --no-open   浏览器版启动后不自动打开浏览器
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

if [[ "$MODE" == "desktop" ]]; then
  command -v cargo >/dev/null 2>&1 || fail "桌面版需要 Rust / Cargo。安装后可改用 ./start.command --web。"
  command -v rustc >/dev/null 2>&1 || fail "桌面版需要 rustc。安装后可改用 ./start.command --web。"
  info "Rust $(rustc --version | awk '{print $2}')"
fi

if [[ ! -d node_modules ]] || [[ package-lock.json -nt node_modules/.package-lock.json ]]; then
  info "安装依赖..."
  npm install --no-audit --no-fund
fi

port_in_use() {
  command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
}

ORCHESTRATOR_PORT="${CRAFTMATE_PORT:-4321}"
if port_in_use "$ORCHESTRATOR_PORT"; then
  fail "端口 ${ORCHESTRATOR_PORT} 已被占用。请先运行 ./stop.command 清理本项目残留进程；若被其他程序占用，请停止它或运行 CRAFTMATE_PORT=4400 ./start.command"
fi
VOICE_PORT="${VOICE_PORT:-4323}"
if port_in_use "$VOICE_PORT"; then
  fail "端口 ${VOICE_PORT} 已被占用。请先运行 ./stop.command 清理本项目残留进程；若被其他程序占用，请停止它或运行 VOICE_PORT=4402 ./start.command"
fi
CONSOLE_PORT="${CRAFTMATE_CONSOLE_PORT:-5173}"
if port_in_use "$CONSOLE_PORT"; then
  fail "端口 ${CONSOLE_PORT} 已被占用。请先运行 ./stop.command 清理本项目残留进程；若被其他程序占用，请停止它或运行 CRAFTMATE_CONSOLE_PORT=5174 ./start.command。"
fi

info "Orchestrator: ws://127.0.0.1:${ORCHESTRATOR_PORT}/control"
info "Voice:        ws://127.0.0.1:${VOICE_PORT}/voice"
info "健康检查:     http://127.0.0.1:${ORCHESTRATOR_PORT}/health"
if [[ "$MODE" == "desktop" ]]; then
  info "桌面窗口:     启动后会弹出 CraftMate 窗口"
else
  info "管理端:       http://localhost:${CONSOLE_PORT}"
fi
info "按 Ctrl+C 停止"

if [[ "$MODE" == "web" && "$OPEN_BROWSER" == "1" ]] && command -v open >/dev/null 2>&1; then
  (
    for _ in {1..40}; do
      if curl -fsS -o /dev/null --max-time 1 "http://localhost:${CONSOLE_PORT}/" 2>/dev/null; then
        open "http://localhost:${CONSOLE_PORT}" >/dev/null 2>&1 || true
        exit 0
      fi
      sleep 0.5
    done
  ) &
fi

exec node tools/dev.mjs "$MODE"
