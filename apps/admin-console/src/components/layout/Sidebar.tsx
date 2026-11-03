import type { DrawerMode } from "../operations/OperationsDrawer.tsx";
import type { ShowMode, ShowSettings, SourceHealth, VoiceStatus } from "@craftmate/contracts";
import type { WireState } from "../../lib/connection.ts";

interface SidebarProps {
  readonly drawer: DrawerMode | null;
  readonly state: WireState;
  readonly mode: ShowMode;
  readonly personaName: string;
  readonly settings: ShowSettings | null;
  readonly sourceHealth: SourceHealth | null;
  readonly voiceStatus: VoiceStatus | null;
  readonly onSelect: (drawer: DrawerMode | null) => void;
}

interface NavigationItem {
  readonly label: string;
  readonly detail: string;
  readonly drawer: DrawerMode;
  readonly icon: React.JSX.Element;
}

const LIVE_ITEMS: readonly NavigationItem[] = [
  {
    label: "直播总览",
    detail: "场景与主线",
    drawer: "decisions",
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4.5 6.5h15v10h-15zM9 20h6M12 16.5V20" />
        <path d="m10 9.5 5 2-5 2z" />
      </svg>
    ),
  },
  {
    label: "评论与决策",
    detail: "仲裁记录",
    drawer: "decisions",
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M5 5.5h14v10H9l-4 3z" />
        <path d="M8.5 9h7M8.5 12h4" />
      </svg>
    ),
  },
  {
    label: "角色与人格",
    detail: "大肥鱼",
    drawer: "persona",
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 4.2 19 8v8l-7 3.8L5 16V8z" />
        <path d="M9 11.5h.01M15 11.5h.01M9.5 15c1.6 1 3.4 1 5 0" />
      </svg>
    ),
  },
] as const;

const SYSTEM_ITEMS: readonly NavigationItem[] = [
  {
    label: "接入与语音",
    detail: "抖音 / TTS",
    drawer: "connections",
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M6.5 12a5.5 5.5 0 0 1 11 0" />
        <path d="M9.2 12a2.8 2.8 0 0 1 5.6 0M12 12v7" />
        <path d="M7 19h10" />
      </svg>
    ),
  },
  {
    label: "设置",
    detail: "资料与界面",
    drawer: "settings",
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="3" />
        <path d="M12 3.5v2M12 18.5v2M20.5 12h-2M5.5 12h-2M17.9 6.1l-1.4 1.4M7.5 16.5l-1.4 1.4M17.9 17.9l-1.4-1.4M7.5 7.5 6.1 6.1" />
        <circle cx="12" cy="12" r="7.4" />
      </svg>
    ),
  },
] as const;

export function Sidebar({
  drawer,
  state,
  mode,
  personaName,
  settings,
  sourceHealth,
  voiceStatus,
  onSelect,
}: SidebarProps): React.JSX.Element {
  const statusLabel = state === "open" ? "内核在线" : state === "connecting" ? "正在连接" : "内核离线";

  return (
    <aside className="sidebar" aria-label="主导航">
      <section className="account" aria-labelledby="account-title">
        <h2 id="account-title" className="sidebar__section-title">账户</h2>
        <div className="account__card">
          <WhaleAvatar />
          <div className="account__copy">
            <strong>{personaName}</strong>
            <span>{settings?.accountLabel ?? "专用直播账号"}</span>
          </div>
          <span className="account__badge">玩家</span>
        </div>
      </section>

      <nav className="sidebar__nav" aria-label="工作区">
        <section className="sidebar__group">
          <h2 className="sidebar__section-title">直播</h2>
          <NavigationButton
            item={LIVE_ITEMS[0]!}
            selected={drawer === null}
            onClick={() => onSelect(null)}
          />
          <NavigationButton
            item={LIVE_ITEMS[1]!}
            selected={drawer === "decisions"}
            onClick={() => onSelect("decisions")}
          />
        </section>

        <section className="sidebar__group">
          <h2 className="sidebar__section-title">角色</h2>
          <NavigationButton
            item={LIVE_ITEMS[2]!}
            selected={drawer === "persona"}
            onClick={() => onSelect("persona")}
          />
        </section>

        <section className="sidebar__group">
          <h2 className="sidebar__section-title">通用</h2>
          {SYSTEM_ITEMS.map((item) => (
            <NavigationButton
              key={item.label}
              item={item}
              selected={drawer === item.drawer}
              onClick={() => onSelect(item.drawer)}
            />
          ))}
        </section>
      </nav>

      <div className="sidebar__footer">
        <div className="daemon-status" data-state={sourceState(state, sourceHealth)}>
          <span className="daemon-status__dot" aria-hidden="true" />
          <div>
            <strong>{sourceLabel(sourceHealth)}</strong>
            <span>{sourceHealth?.detail ?? "尚未接入抖音"}</span>
          </div>
        </div>
        <div className="daemon-status" data-state={state}>
          <span className="daemon-status__dot" aria-hidden="true" />
          <div>
            <strong>{statusLabel}</strong>
            <span>{modeLabel(mode)}</span>
          </div>
        </div>
        <div className="daemon-status" data-state={voiceState(state, voiceStatus)}>
          <span className="daemon-status__dot" aria-hidden="true" />
          <div>
            <strong>{voiceLabel(voiceStatus)}</strong>
            <span>{voiceStatus?.detail ?? "语音服务未连接"}</span>
          </div>
        </div>
        <span className="sidebar__build">v0.0.1 · 本地开发</span>
      </div>
    </aside>
  );
}

/** Ingress state, folded with the console link so one dot never shows two truths. */
function sourceState(link: WireState, health: SourceHealth | null): WireState {
  if (link !== "open") return link;
  if (!health) return "connecting";
  return health.state === "open" ? "open" : health.state === "connecting" ? "connecting" : "error";
}

function sourceLabel(health: SourceHealth | null): string {
  if (!health) return "抖音未接入";
  switch (health.state) {
    case "open":
      return "抖音评论在线";
    case "connecting":
      return "抖音连接中";
    case "closed":
      return "直播间已关闭";
    default:
      return "抖音断开";
  }
}

function voiceState(link: WireState, voice: VoiceStatus | null): WireState {
  if (link !== "open" || !voice) return link === "open" ? "connecting" : link;
  if (voice.state === "degraded" || voice.state === "disabled") return "error";
  return "open";
}

function voiceLabel(voice: VoiceStatus | null): string {
  if (!voice) return "语音未接入";
  if (voice.state === "speaking") return "正在说话";
  if (voice.state === "degraded") return "语音降级";
  if (voice.state === "disabled") return "语音已停用";
  return "语音待命";
}

interface NavigationButtonProps {
  readonly item: NavigationItem;
  readonly selected: boolean;
  readonly onClick: () => void;
}

function NavigationButton({ item, selected, onClick }: NavigationButtonProps): React.JSX.Element {
  return (
    <button
      type="button"
      className="nav-item"
      data-selected={selected}
      aria-current={selected ? "page" : undefined}
      onClick={onClick}
    >
      <span className="nav-item__icon">{item.icon}</span>
      <span className="nav-item__copy">
        <strong>{item.label}</strong>
        <small>{item.detail}</small>
      </span>
      <Chevron />
    </button>
  );
}

function modeLabel(mode: ShowMode): string {
  switch (mode) {
    case "operator":
      return "操作员接管";
    case "stopped":
      return "已急停";
    default:
      return "Agent 待命";
  }
}

function WhaleAvatar(): React.JSX.Element {
  return (
    <svg className="account__avatar" viewBox="0 0 64 64" role="img" aria-label="大肥鱼像素头像">
      <rect width="64" height="64" rx="4" fill="#dce9fb" />
      <path fill="#2a3c79" d="M9 30h5v-6h5v-5h17v5h5v6h5v10h-5v5H24v5h-5v-5H9z" />
      <path fill="#5578cf" d="M19 24h17v18H19zM14 30h5v11h-5zM36 30h5v11h-5z" />
      <path fill="#d8efff" d="M19 35h5v4h-5zM31 35h5v4h-5z" />
      <path fill="#ffcf8a" d="M24 42h8v4h-8z" />
      <path fill="#f2f7ff" d="M24 24h5v5h-5z" />
      <path fill="#6f8ee0" d="M42 37h7v5h-4v4h-3z" />
    </svg>
  );
}

function Chevron(): React.JSX.Element {
  return (
    <svg className="nav-item__chevron" viewBox="0 0 16 16" aria-hidden="true">
      <path d="m6 3.5 4.5 4.5L6 12.5" />
    </svg>
  );
}
