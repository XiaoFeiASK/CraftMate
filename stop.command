#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"
ROOT="$(pwd -P)"

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run)
      DRY_RUN=1
      ;;
    -h|--help)
      cat <<'EOF'
用法: ./stop.command [--dry-run]

停止由本仓库启动的 CraftMate 本地进程，并检查常用端口是否已释放。
只会结束工作目录或命令行属于当前仓库的 node / npm / Vite / Tauri 进程，
不会按进程名全局清理，也不会结束占用端口的其他程序。

检查端口:
  4321  Orchestrator
  4322  Ingress 健康检查
  4323  Voice / Bridge 默认端口
  5173  管理端 Vite
  4391  Bridge 模拟身体示例端口

设置了 CRAFTMATE_PORT、VOICE_PORT、INGRESS_HEALTH_PORT 或 BRIDGE_PORT
时，脚本也会检查对应的自定义端口。

选项:
  --dry-run   只列出将停止的进程和端口占用，不结束任何进程
EOF
      exit 0
      ;;
    *)
      printf '未知参数: %s（使用 --help 查看用法）\n' "$arg" >&2
      exit 2
      ;;
  esac
done

info() {
  printf '▸ %s\n' "$*"
}

warn() {
  printf '! %s\n' "$*" >&2
}

fail() {
  printf '错误: %s\n' "$*" >&2
  exit 1
}

command -v ps >/dev/null 2>&1 || fail "未找到 ps。"
command -v lsof >/dev/null 2>&1 || fail "未找到 lsof；macOS 应自带该命令。"

PORTS="4321 4322 4323 5173 4391"
for configured_port in "${CRAFTMATE_PORT:-}" "${VOICE_PORT:-}" "${INGRESS_HEALTH_PORT:-}" "${BRIDGE_PORT:-}"; do
  [[ -n "$configured_port" ]] && PORTS="${PORTS} ${configured_port}"
done

dedup_ports() {
  local result="" port
  for port in $1; do
    case " ${result} " in
      *" ${port} "*) ;;
      *) result="${result} ${port}" ;;
    esac
  done
  printf '%s\n' "$result"
}

PORTS="$(dedup_ports "$PORTS")"

process_command() {
  ps -p "$1" -o command= 2>/dev/null | sed -n '1p' || true
}

process_cwd() {
  lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | sed -n '1p' || true
}

process_state() {
  ps -p "$1" -o stat= 2>/dev/null | tr -d ' ' | sed -n '1p' || true
}

pid_alive() {
  local state
  state="$(process_state "$1")"
  case "$state" in
    ""|Z*) return 1 ;;
    *) return 0 ;;
  esac
}

is_runtime_command() {
  case "$1" in
    node\ *|*/node\ *|node|*/node|\
    npm\ *|*/npm\ *|npm|*/npm|\
    npx\ *|*/npx\ *|npx|*/npx|\
    cargo\ *|*/cargo\ *|cargo|*/cargo|\
    tauri\ *|*/tauri\ *|tauri|*/tauri|\
    *"/esbuild "*|*/esbuild|\
    *"/tsx "*|*"/vite "*|\
    *"/target/debug/craftmate"*|*"/target/release/craftmate"*)
      return 0
      ;;
  esac
  return 1
}

references_project() {
  case "$1" in
    *"$ROOT"/node_modules/*|*"$ROOT"/services/*|*"$ROOT"/apps/*|\
    *"$ROOT"/packages/*|*"$ROOT"/tools/*|*"$ROOT"/db/*)
      return 0
      ;;
  esac
  return 1
}

is_project_command() {
  case "$1" in
    *"tools/dev.mjs"*|*"dev:orchestrator"*|*"dev:voice"*|*"dev:console"*|\
    *"dev:desktop"*|*"dev:ingress"*|*"dev:bridge"*|*"npm run dev"*|\
    *"tsx watch"*|*"vite --port"*|*"tauri dev"*|*"cargo run"*|\
    *"tools/mock.ts"*|*"tools/fake/dyhub.mjs"*|*"tools/bridge/sim-body.mjs"*|\
    *"tools/bridge/smoke.mjs"*|*"tools/bridge/long-run.mjs"*|*"src/main.ts"*)
      return 0
      ;;
  esac
  return 1
}

is_project_workdir() {
  case "$1" in
    "$ROOT"|"$ROOT"/services/*|"$ROOT"/apps/*|"$ROOT"/tools/*|"$ROOT"/packages/*)
      return 0
      ;;
  esac
  return 1
}

listener_pids() {
  lsof -tiTCP:"$1" -sTCP:LISTEN 2>/dev/null | sort -u || true
}

PIDS=" "

has_pid() {
  case "$PIDS" in
    *" $1 "*) return 0 ;;
  esac
  return 1
}

add_pid() {
  has_pid "$1" || PIDS="${PIDS}$1 "
}

pid_count() {
  local pid count=0
  for pid in $PIDS; do
    count=$((count + 1))
  done
  printf '%s\n' "$count"
}

collect_descendants() {
  local before after pid ppid state cmd
  while :; do
    before="$(pid_count)"
    while read -r pid ppid state cmd; do
      [[ -n "$pid" ]] || continue
      case "$state" in
        Z*) continue ;;
      esac
      if has_pid "$ppid" && ! has_pid "$pid"; then
        add_pid "$pid"
      fi
    done < <(ps -axo pid=,ppid=,stat=,command=)
    after="$(pid_count)"
    [[ "$before" == "$after" ]] && break
  done
}

listener_is_owned() {
  local pid="$1" cmd cwd
  cmd="$(process_command "$pid")"
  cwd="$(process_cwd "$pid")"
  is_runtime_command "$cmd" || return 1
  references_project "$cmd" && return 0
  is_project_workdir "$cwd"
}

discover_project_processes() {
  local pid ppid state cmd cwd port
  PIDS=" "
  while read -r pid ppid state cmd; do
    [[ -n "$pid" ]] || continue
    [[ "$pid" == "$$" || "$pid" == "$PPID" ]] && continue
    case "$state" in
      Z*) continue ;;
    esac
    is_runtime_command "$cmd" || continue
    if references_project "$cmd"; then
      add_pid "$pid"
      continue
    fi
    is_project_command "$cmd" || continue
    cwd="$(process_cwd "$pid")"
    is_project_workdir "$cwd" && add_pid "$pid"
  done < <(ps -axo pid=,ppid=,stat=,command=)

  for port in $PORTS; do
    for pid in $(listener_pids "$port"); do
      listener_is_owned "$pid" && add_pid "$pid"
    done
  done
  collect_descendants
}

print_processes() {
  local pid cmd cwd
  for pid in $PIDS; do
    cmd="$(process_command "$pid")"
    cwd="$(process_cwd "$pid")"
    printf '  - PID %-7s cwd: %s\n' "$pid" "${cwd:-?}"
    printf '    %s\n' "$cmd"
  done
}

terminate_processes() {
  local pid survivors="" i state
  for pid in $PIDS; do
    pid_alive "$pid" || continue
    kill -TERM "$pid" 2>/dev/null || true
  done

  i=0
  while [[ $i -lt 20 ]]; do
    sleep 0.2
    survivors=""
    for pid in $PIDS; do
      pid_alive "$pid" && survivors="${survivors}${pid} "
    done
    [[ -z "$survivors" ]] && return 0
    i=$((i + 1))
  done

  warn "以下进程未在 4 秒内退出，发送 SIGKILL: ${survivors}"
  for pid in $survivors; do
    kill -KILL "$pid" 2>/dev/null || true
  done

  i=0
  while [[ $i -lt 10 ]]; do
    sleep 0.2
    survivors=""
    for pid in $PIDS; do
      pid_alive "$pid" && survivors="${survivors}${pid} "
    done
    [[ -z "$survivors" ]] && return 0
    i=$((i + 1))
  done
  warn "仍有进程未退出: ${survivors}"
}

check_ports() {
  local blocked=0 port pid cmd cwd
  for port in $PORTS; do
    for pid in $(listener_pids "$port"); do
      blocked=1
      cmd="$(process_command "$pid")"
      cwd="$(process_cwd "$pid")"
      printf '✗ 端口 %s 仍被占用: PID %s\n' "$port" "$pid" >&2
      printf '  cwd: %s\n' "${cwd:-?}" >&2
      printf '  %s\n' "$cmd" >&2
    done
  done
  return "$blocked"
}

info "CraftMate 一键停止"
info "仓库: ${ROOT}"

discover_project_processes
PROCESS_COUNT="$(pid_count)"

if [[ "$PROCESS_COUNT" -eq 0 ]]; then
  info "未发现本项目的残留进程。"
else
  info "发现 ${PROCESS_COUNT} 个项目相关进程:"
  print_processes
  if [[ "$DRY_RUN" -eq 1 ]]; then
    info "dry-run：未结束任何进程。"
  else
    info "正在停止..."
    terminate_processes

    sleep 0.3
    discover_project_processes
    PROCESS_COUNT="$(pid_count)"
    if [[ "$PROCESS_COUNT" -gt 0 ]]; then
      info "仍有 ${PROCESS_COUNT} 个进程被重新拉起，继续清理:"
      print_processes
      terminate_processes
    fi
  fi
fi

if [[ "$DRY_RUN" -eq 1 ]]; then
  check_ports || info "dry-run：以上端口占用保持不变。"
  exit 0
fi

if ! check_ports; then
  printf '\n端口仍被占用。上面列出的进程不属于本脚本识别的 CraftMate 项目进程；\n' >&2
  printf '请确认后手动停止，或检查以上 PID 是否为其他程序。\n' >&2
  exit 1
fi

info "已停止 CraftMate 本地进程，相关端口均已释放。"
