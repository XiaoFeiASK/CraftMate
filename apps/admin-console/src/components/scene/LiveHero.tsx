import type { ShowMode, ShowStats } from "@craftmate/contracts";
import type { WireState } from "../../lib/connection.ts";
import cherryGrove from "../../assets/cherry-grove.jpg";
import dafeiyu from "../../assets/dafeiyu.png";

interface LiveHeroProps {
  readonly state: WireState;
  readonly mode: ShowMode;
  readonly personaName: string;
  readonly stats: ShowStats;
  readonly target: string;
  readonly onOpenConsole: () => void;
}

export function LiveHero({ state, mode, personaName, stats, target, onOpenConsole }: LiveHeroProps): React.JSX.Element {
  const progress = Math.min(0.94, 0.18 + stats.executed * 0.05);
  const online = state === "open";

  return (
    <main className="hero">
      <img className="hero__photo" src={cherryGrove} alt="" />
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
        <div className="session-card__copy">
          <div className="session-card__identity">
            <span className="session-card__eyebrow">本场 Agent</span>
            <h1 id="session-title">{personaName}</h1>
            <p>{modeLabel(mode)}</p>
          </div>

          <div className="session-card__objective">
            <span>今日主线</span>
            <strong>{target}</strong>
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

        <img className="session-card__mascot" src={dafeiyu} alt="大肥鱼角色立绘" />
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
