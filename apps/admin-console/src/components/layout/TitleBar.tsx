import type { ShowMode, ShowSettings } from "@craftmate/contracts";
import type { DrawerMode } from "../operations/OperationsDrawer.tsx";
import type { WireState } from "../../lib/connection.ts";
import mascotLogo from "../../assets/dafeiyu.png";

const dragRegion = { "data-tauri-drag-region": true } as const;

interface TitleBarProps {
  readonly view: DrawerMode | null;
  readonly state: WireState;
  readonly mode: ShowMode;
  readonly settings: ShowSettings | null;
  readonly onSelect: (view: DrawerMode | null) => void;
}

/** The sidebar is the only navigation; the title bar names where you are and how the show is running. */
const VIEW_LABELS: Record<DrawerMode, string> = {
  decisions: "评论与决策",
  persona: "角色与人格",
  connections: "接入与语音",
  settings: "设置",
  memory: "记忆与版本",
  replay: "回放",
};

export function TitleBar({ view, state, mode, settings, onSelect }: TitleBarProps): React.JSX.Element {
  const webPreview = !("__TAURI_INTERNALS__" in window);
  const run = runStatus(state, mode);

  return (
    <header className="titlebar" {...dragRegion}>
      {webPreview ? (
        <span className="traffic-lights" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
      ) : null}

      <div className="titlebar__brand" {...dragRegion}>
        <img className="titlebar__logo" src={mascotLogo} alt="" aria-hidden="true" />
        <strong>CraftMate</strong>
      </div>

      <span className="titlebar__crumb" {...dragRegion}>
        {view ? VIEW_LABELS[view] : "直播总览"}
      </span>

      <div className="titlebar__drag" {...dragRegion} />

      <div className="titlebar__status" {...dragRegion}>
        <span className="titlebar__world" title="场景占位：Fabric Bridge 接入后替换为实时游戏画面">
          <span className="titlebar__cube" aria-hidden="true" />
          {settings?.worldName ?? "正在读取世界"}
          <small>{settings?.gameVersion ?? "—"}</small>
        </span>
        <span className="titlebar__run" data-tone={run.tone} role="status">
          <span aria-hidden="true" />
          {run.label}
        </span>
      </div>

      <div className="titlebar__actions">
        <button
          className="titlebar__button"
          type="button"
          aria-label="重新载入并重连内核"
          title="重新载入并重连内核"
          onClick={() => window.location.reload()}
        >
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="M15.6 7.2A6 6 0 1 0 16 11" />
            <path d="M16.2 3.8v3.8h-3.8" />
          </svg>
        </button>
        <button
          className="titlebar__button"
          type="button"
          aria-label="设置"
          title="设置"
          aria-pressed={view === "settings"}
          data-current={view === "settings"}
          onClick={() => onSelect(view === "settings" ? null : "settings")}
        >
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <circle cx="10" cy="10" r="2.5" />
            <path d="M10 3.2v1.4M10 15.4v1.4M16.8 10h-1.4M4.6 10H3.2M14.8 5.2l-1 1M6.2 13.8l-1 1M14.8 14.8l-1-1M6.2 6.2l-1-1" />
            <circle cx="10" cy="10" r="6.1" />
          </svg>
        </button>
      </div>
    </header>
  );
}

function runStatus(state: WireState, mode: ShowMode): { readonly label: string; readonly tone: string } {
  if (state === "connecting") return { label: "正在连接内核", tone: "warn" };
  if (state !== "open") return { label: "内核离线", tone: "bad" };
  if (mode === "operator") return { label: "操作员接管", tone: "warn" };
  if (mode === "stopped") return { label: "已急停", tone: "bad" };
  return { label: "Agent 主控", tone: "good" };
}
