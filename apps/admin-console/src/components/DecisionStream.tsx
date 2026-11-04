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
          <small>接入抖音评论后，真实数据会显示在这里。</small>
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
              <Outcome outcome={decision.outcome} />
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

const OUTCOME_LABELS: Record<string, string> = {
  completed: "已完成",
  failed: "失败",
  timeout: "超时",
  cancelled: "已取消",
  preempted: "被顶替",
};

/**
 * "It decided to chop" and "it chopped two logs" are different claims. The
 * outcome block only appears once the body has settled the skill, so a missing
 * block means the result is still unknown rather than successful.
 */
function Outcome({
  outcome,
}: {
  readonly outcome: Decision["outcome"];
}): React.JSX.Element | null {
  if (!outcome) return null;
  const detail = outcome.outcome;
  const changes = detail?.changes?.length ?? 0;
  return (
    <div className="decided__outcome" data-status={outcome.status}>
      <span>{OUTCOME_LABELS[outcome.status] ?? outcome.status}</span>
      {detail?.summary ? <span>{detail.summary}</span> : null}
      {changes > 0 ? <span>{changes} 处变化</span> : null}
      {detail?.unconfirmed?.length ? (
        <span className="decided__unconfirmed">{detail.unconfirmed.length} 项待确认</span>
      ) : null}
      {outcome.detail && !detail?.summary ? <span>{outcome.detail}</span> : null}
      {detail?.problem ? <span>{detail.problem}</span> : null}
    </div>
  );
}
