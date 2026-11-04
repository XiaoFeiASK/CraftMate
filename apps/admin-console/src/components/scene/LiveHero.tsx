import type { BridgeHealth } from "@craftmate/contracts";
import { useEffect, useRef } from "react";

/** Bundled scene used only while no real game frame is available. */
const SCENE_VIDEO = "/scene/pond-loop.mp4";
const SCENE_POSTER = "/scene/pond-poster.jpg";

interface LiveHeroProps {
  readonly reduceMotion: boolean;
  readonly bridge: BridgeHealth | null;
}

/** The stage is the game picture only; session data lives in the sidebar. */
export function LiveHero({ reduceMotion, bridge }: LiveHeroProps): React.JSX.Element {
  const video = useRef<HTMLVideoElement>(null);
  const inGame = bridge?.connected === true && bridge.world?.inWorld === true;

  // A wallpaper is only worth its decode cost while it is actually on screen.
  // The app preference, the OS preference, and a hidden window all fall back
  // to the poster frame.
  useEffect(() => {
    const element = video.current;
    if (!element) return;
    if (inGame) {
      element.pause();
      return;
    }
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
  }, [inGame, reduceMotion]);

  return (
    <main className="hero" aria-label="游戏画面">
      {inGame ? (
        <div className="hero__live" role="status">
          <span className="hero__live-badge">LIVE</span>
          <strong>CraftMate 游戏身体已连接</strong>
          <span>
            {bridge.client ?? "Minecraft"} · {bridge.skills.length} 个可用动作
          </span>
          <small>
            游戏画面截图通道尚未接入；这里不会播放演示画面冒充实时画面。
          </small>
        </div>
      ) : (
        <>
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
          <div className="hero__offline" role="status">
            <span className="hero__offline-badge">无游戏画面</span>
            <strong>Minecraft 尚未连接</strong>
            <small>等待 Fabric 游戏身体通过 Bridge 上报真实世界状态。</small>
          </div>
        </>
      )}
    </main>
  );
}

