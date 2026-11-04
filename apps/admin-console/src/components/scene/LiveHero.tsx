import type { BridgeHealth } from "@craftmate/contracts";
import { useEffect, useRef, useState } from "react";

/** Bundled scene used as the stage backdrop until real game frames arrive. */
const SCENE_VIDEO = `${import.meta.env.BASE_URL}scene/pond-loop.mp4`;
const SCENE_POSTER = `${import.meta.env.BASE_URL}scene/pond-poster.jpg`;

/**
 * The body serves JPEG frames from loopback. It is deliberately outside the
 * bridge protocol: the picture can stall or be absent without affecting
 * command ownership or liveness.
 */
const STREAM_URL =
  import.meta.env.VITE_CRAFTMATE_STREAM_URL ?? "http://127.0.0.1:4324/stream.mjpg";

interface LiveHeroProps {
  readonly reduceMotion: boolean;
  readonly bridge: BridgeHealth | null;
}

/** The stage is the game picture only; session data lives in the sidebar. */
export function LiveHero({ reduceMotion, bridge }: LiveHeroProps): React.JSX.Element {
  const video = useRef<HTMLVideoElement>(null);
  const inGame = bridge?.connected === true && bridge.world?.inWorld === true;
  const [live, setLive] = useState(false);
  /** Hide the clip as soon as the first stream part is being decoded. */
  const [painting, setPainting] = useState(false);
  const [streamKey, setStreamKey] = useState(0);

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

  // The body pushes JPEG parts over one long-lived response. The img paints
  // each part as it arrives, so there is no polling or blob churn.
  useEffect(() => {
    if (!inGame) {
      setLive(false);
      setPainting(false);
      return;
    }
    // A stream that never produced a first part looks the same as one that
    // dropped; retrying keeps a restarted game recoverable without a reload.
    const retry = window.setInterval(() => {
      if (!live) setStreamKey((key) => key + 1);
    }, 4_000);
    return () => window.clearInterval(retry);
  }, [inGame, live]);

  return (
    <main className="hero" aria-label="游戏画面">
      <video
        ref={video}
        className="hero__video"
        data-hidden={painting ? "true" : "false"}
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
      {inGame ? (
        <img
          key={streamKey}
          className="hero__frame"
          data-painting={painting ? "true" : "false"}
          src={`${STREAM_URL}?session=${streamKey}`}
          alt=""
          aria-hidden="true"
          onLoad={() => {
            setLive(true);
            setPainting(true);
          }}
          onError={() => {
            setLive(false);
            setPainting(false);
          }}
        />
      ) : null}
      {inGame ? (
        <div className="hero__status" role="status">
          <span
            className={live ? "hero__dot hero__dot--live" : "hero__dot"}
            aria-hidden="true"
          />
          <span>{live ? "LIVE" : "连接中"}</span>
          <span className="hero__status-meta">
            {bridge.client ?? "Minecraft"} · {bridge.skills.length} 个动作
          </span>
        </div>
      ) : (
        <div className="hero__status" role="status">
          <span className="hero__dot" aria-hidden="true" />
          <span>演示画面</span>
          <span className="hero__status-meta">Minecraft 尚未连接</span>
        </div>
      )}
    </main>
  );
}

