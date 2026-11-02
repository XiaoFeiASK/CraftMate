import { closeWindow, maximizeWindow, minimizeWindow } from "../../lib/window-controls.ts";

const dragRegion = { "data-tauri-drag-region": true } as const;

export function TitleBar(): React.JSX.Element {
  return (
    <header className="titlebar" {...dragRegion}>
      <div className="titlebar__brand" {...dragRegion}>
        <span className="titlebar__logo" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
        <strong>CraftMate</strong>
        <span className="titlebar__version">直播控制台 0.1</span>
      </div>

      <div className="titlebar__drag" {...dragRegion} />

      <div className="titlebar__controls">
        <button className="window-button" type="button" aria-label="帮助">
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <circle cx="10" cy="10" r="7.25" />
            <path d="M7.9 7.8a2.2 2.2 0 1 1 3.1 2c-.7.35-1 .8-1 1.6" />
            <path d="M10 14.4h.01" />
          </svg>
        </button>
        <button className="window-button" type="button" aria-label="最小化" onClick={() => void minimizeWindow()}>
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="M5 10h10" />
          </svg>
        </button>
        <button className="window-button" type="button" aria-label="最大化" onClick={() => void maximizeWindow()}>
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <rect x="5.5" y="5.5" width="9" height="9" rx=".4" />
          </svg>
        </button>
        <button className="window-button window-button--close" type="button" aria-label="关闭" onClick={() => void closeWindow()}>
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="m6 6 8 8M14 6l-8 8" />
          </svg>
        </button>
      </div>
    </header>
  );
}
