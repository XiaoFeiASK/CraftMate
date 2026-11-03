import type { Decision, DecisionKind } from "@craftmate/contracts";
import { clock } from "../lib/format.ts";

const LABELS: Record<DecisionKind, string> = {
  IGNORE: "忽略",
  OBSERVE: "观察",
  ACK_ONLY: "回应",
  QUEUE: "排队",
  EXECUTE: "执行",
  REFUSE: "拒绝",
};

const PRIORITY_LABELS: Record<Decision["priority"], string> = {
  reflex: "P0 反射",
  safety: "P2 安全",
  operator: "P1 操作员",
  promise: "P3 承诺",
  plan: "P4 计划",
  vote: "P5 投票",
  command: "P6 指令",
  ambient: "P7 闲聊",
};

interface DecisionStreamProps {
  readonly decisions: readonly Decision[];
}

export function DecisionStream({ decisions }: DecisionStreamProps): React.JSX.Element {
  return (
    <aside className="stream" aria-label="决策流">
      <header className="stream__head">
        <h2>决策流</h2>
        <span>{decisions.length}</span>
      </header>

      {decisions.length === 0 ? (
        <div className="stream__empty">
          <p>还没有评论进来。</p>
          <small>点右下角「模拟一波」可以先看效果。</small>
        </div>
      ) : (
        <ol className="stream__list">
          {decisions.map((decision) => (
            <li key={decision.id} className="decided" data-kind={decision.decision}>
              <div className="decided__top">
                <span className="decided__badge">{LABELS[decision.decision]}</span>
                <span className="decided__nickname">{decision.nickname}</span>
                <time className="decided__time">{clock(decision.at)}</time>
              </div>
              <p className="decided__text">{decision.text || "（无文字）"}</p>
              <div className="decided__meta">
                <span>{decision.intent}</span>
                <span data-priority={decision.priority}>{PRIORITY_LABELS[decision.priority]}</span>
                <span className="decided__score">分 {decision.score.toFixed(2)}</span>
                {decision.stage === "planned" ? <span>Stage C</span> : null}
                {decision.skill ? <span>{decision.skill.name}</span> : null}
              </div>
              <p className="decided__reason">{decision.reason}</p>
              {decision.speech ? <p className="decided__speech">「{decision.speech}」</p> : null}
              {decision.trace ? (
                <p className="decided__trace">
                  {decision.trace.provider} / {decision.trace.model} · {decision.trace.latencyMs}ms
                  {decision.trace.degraded ? " · 模板降级" : ""}
                </p>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </aside>
  );
}
