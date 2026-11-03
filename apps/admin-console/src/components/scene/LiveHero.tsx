import { useEffect, useRef } from "react";
import type { ShowMode, ShowSettings, ShowStats } from "@craftmate/contracts";
import type { WireState } from "../../lib/connection.ts";
import dafeiyu from "../../assets/dafeiyu.png";

/** Looping pond scene. Bundled from public/ so it keeps the original bitrate. */
const SCENE_VIDEO = "/scene/pond-loop.mp4";
const SCENE_POSTER = "/scene/pond-poster.jpg";

interface LiveHeroProps {
  readonly state: WireState;
  readonly mode: ShowMode;
  readonly personaName: string;
  readonly settings: ShowSettings | null;
  readonly stats: ShowStats;
  readonly reduceMotion: boolean;
  readonly onOpenConsole: () => void;
}

export function LiveHero({
  state,
  mode,
  personaName,
  settings,
  stats,
  reduceMotion,
  onOpenConsole,
}: LiveHeroProps): React.JSX.Element {
  const progress = (settings?.goalProgress ?? 0) / 100;
  const online = state === "open";
  const video = useRef<HTMLVideoElement>(null);

  // A wallpaper is only worth its decode cost while it is actually on screen.
  // The app preference, the OS preference, and a hidden window all fall back
  // to the poster frame.
  useEffect(() => {
    const element = video.current;
    if (!element) return;
    const systemReduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = (): void => {
      const shouldPlay =
        !reduceMotion && !systemReduce.matches && document.visibilityState === "visible";
      if (shouldPlay) {
        void element.play().catch(() => {
          // Autoplay can be refused; the poster frame is a valid fallback.
        });
      } else {
        element.pause();
      }
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    systemReduce.addEventListener("change", sync);
    return () => {
      document.removeEventListener("visibilitychange", sync);
      systemReduce.removeEventListener("change", sync);
    };
  }, [reduceMotion]);

  return (
    <main className="hero">
      <video
        ref={video}
        className="hero__video"
        src={SCENE_VIDEO}
        poster={SCENE_POSTER}
        autoPlay
        muted
        loop
        playsInline
        preload="auto"
        disablePictureInPicture
        aria-hidden="true"
        tabIndex={-1}
      />
      <div className="hero__veil" aria-hidden="true" />

      <header className="hero__top">
        <div className="world-chip">
          <span className="world-chip__cube" aria-hidden="true" />
          <span>{settings?.worldName ?? "正在读取世界"}</span>
          <i aria-hidden="true" />
          <span>{settings?.gameVersion ?? "—"}</span>
        </div>
        <div className="live-chip" data-state={state}>
          <span aria-hidden="true" />
          {online ? "内核在线" : state === "connecting" ? "连接中" : "内核离线"}
        </div>
      </header>

      <section className="session-card" aria-labelledby="session-title">
        <div className="session-card__copy">
          <div className="session-card__identity">
            <span className="session-card__eyebrow">本场 Agent</span>
            <h1 id="session-title">{personaName}</h1>
            <p>{modeLabel(mode, settings)}</p>
          </div>

          <div className="session-card__objective">
            <span>今日主线</span>
            <strong>{settings?.goal ?? "正在读取本场目标"}</strong>
          </div>

          <div
            className="session-card__progress"
            role="progressbar"
            aria-label="今日主线进度"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progress * 100)}
          >
            <span style={{ width: `${progress * 100}%` }} />
          </div>

          <dl className="session-card__stats">
            <div>
              <dt>已收到</dt>
              <dd>{stats.received}</dd>
            </div>
            <div>
              <dt>待兑现</dt>
              <dd>{stats.openCommitments}</dd>
            </div>
            <div>
              <dt>决策</dt>
              <dd>{stats.decided}</dd>
            </div>
          </dl>
        </div>

        <div className="session-card__portrait">
          <span className="session-card__portrait-shadow" aria-hidden="true" />
          <img className="session-card__mascot" src={dafeiyu} alt="大肥鱼角色立绘" />
        </div>
      </section>

      <button className="launch" type="button" onClick={onOpenConsole}>
        <span className="launch__copy">
          <strong>进入播控台</strong>
          <small>{online ? "查看评论、仲裁与操作" : "等待本地内核启动"}</small>
        </span>
        <span className="launch__arrow" aria-hidden="true">
          <svg viewBox="0 0 20 20">
            <path d="m7 4 6 6-6 6" />
          </svg>
        </span>
      </button>

      <p className="hero__footnote">循环场景占位，Fabric Bridge 接入后替换为实时游戏画面</p>
    </main>
  );
}

function modeLabel(mode: ShowMode, settings: ShowSettings | null): string {
  if (mode === "operator") return "操作员接管中，Agent 已退到旁白。";
  if (mode === "stopped") return "已急停，等待操作员恢复。";
  return `${settings?.persona.tone ?? "待命中"}，正在等你下第一条指令。`;
}
