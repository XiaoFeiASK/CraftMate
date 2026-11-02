import type { ShowMode, Stats, WireState } from "../../lib/wire.ts";
import { VoxelLandscape } from "./VoxelLandscape.tsx";

interface LiveHeroProps {
  readonly state: WireState;
  readonly mode: ShowMode;
  readonly personaName: string;
  readonly stats: Stats;
  readonly target: string;
  readonly onOpenConsole: () => void;
}

export function LiveHero({ state, mode, personaName, stats, target, onOpenConsole }: LiveHeroProps): React.JSX.Element {
  const progress = Math.min(0.94, 0.18 + stats.executed * 0.05);
  const online = state === "open";

  return (
    <main className="hero">
      <VoxelLandscape />
      <div className="hero__veil" aria-hidden="true" />

      <header className="hero__top">
        <div className="world-chip">
          <span className="world-chip__cube" aria-hidden="true" />
          <span>本地单人世界</span>
          <i aria-hidden="true" />
          <span>1.21.11</span>
        </div>
        <div className="live-chip" data-state={state}>
          <span aria-hidden="true" />
          {online ? "内核在线" : state === "connecting" ? "连接中" : "内核离线"}
        </div>
      </header>

      <section className="session-card" aria-labelledby="session-title">
        <div className="session-card__identity">
          <span className="session-card__eyebrow">本场 Agent</span>
          <h1 id="session-title">{personaName}</h1>
          <p>{modeLabel(mode)}</p>
        </div>

        <div className="session-card__objective">
          <span>今日主线</span>
          <strong>{target}</strong>
        </div>

        <div className="session-card__progress">
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
            <dd>{stats.executed + stats.refused + stats.observed}</dd>
          </div>
        </dl>
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

      <p className="hero__footnote">画面为场景占位，Fabric Bridge 接入后替换为实时游戏画面</p>
    </main>
  );
}

function modeLabel(mode: ShowMode): string {
  if (mode === "operator") return "操作员接管中，Agent 已退到旁白。";
  if (mode === "stopped") return "已急停，等待操作员恢复。";
  return "软萌、贪吃，正在等你下第一条指令。";
}
