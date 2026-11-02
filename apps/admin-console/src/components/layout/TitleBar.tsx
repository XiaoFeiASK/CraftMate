import type { DrawerMode } from "../operations/OperationsDrawer.tsx";
import mascotLogo from "../../assets/dafeiyu.png";

const dragRegion = { "data-tauri-drag-region": true } as const;

interface TitleBarProps {
  readonly view: DrawerMode | null;
  readonly onSelect: (view: DrawerMode | null) => void;
}

const TABS: readonly { readonly label: string; readonly view: DrawerMode | null }[] = [
  { label: "总览", view: null },
  { label: "评论区", view: "decisions" },
  { label: "人格", view: "persona" },
  { label: "接入", view: "connections" },
] as const;

export function TitleBar({ view, onSelect }: TitleBarProps): React.JSX.Element {
  const webPreview = !("__TAURI_INTERNALS__" in window);

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
        <span className="titlebar__name">
          <strong>CraftMate</strong>
          <span className="titlebar__version">直播控制台</span>
        </span>
      </div>

      <nav className="titlebar__nav" aria-label="控制台分区">
        {TABS.map((tab) => (
          <button
            key={tab.label}
            type="button"
            className="titlebar__tab"
            data-current={view === tab.view}
            aria-current={view === tab.view ? "page" : undefined}
            onClick={() => onSelect(tab.view)}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      <div className="titlebar__drag" {...dragRegion} />

      <div className="titlebar__meta">
        <button
          className="titlebar__button"
          type="button"
          aria-label="接入与设置"
          onClick={() => onSelect("connections")}
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
