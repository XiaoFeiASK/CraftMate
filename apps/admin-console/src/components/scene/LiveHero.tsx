import { useEffect, useRef } from "react";

/** Looping pond scene. Bundled from public/ so it keeps the original bitrate. */
const SCENE_VIDEO = "/scene/pond-loop.mp4";
const SCENE_POSTER = "/scene/pond-poster.jpg";

interface LiveHeroProps {
  readonly reduceMotion: boolean;
}

/** The stage is the game picture only; session data lives in the sidebar. */
export function LiveHero({ reduceMotion }: LiveHeroProps): React.JSX.Element {
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
    <main className="hero" aria-label="游戏画面">
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
    </main>
  );
}

