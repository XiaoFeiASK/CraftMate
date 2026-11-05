import { useEffect, useRef, useState } from "react";
import type {
  AgentEvent,
  AgentEventStatus,
  Budget,
  Decision,
  GoalProgress,
  IngressMetrics,
  Proposal,
  ShowMode,
  ShowSnapshot,
  TelemetrySnapshot,
  TimelineEntry,
  VoiceStatus,
} from "@craftmate/contracts";
import type { WireState } from "../../lib/connection.ts";
import {
  EVENT_SOURCES,
  STAGE_LABELS,
  STATUS_LABELS,
  currentWork,
  goalProgress,
  groupByTrace,
  ingressIsKnown,
  latestTraceGroup,
  modeLabel,
  pipelineFor,
  queueCount,
  relativeTime,
  voiceLabel,
  type TraceGroup,
} from "../../lib/telemetry-view.ts";
import { clock } from "../../lib/format.ts";

interface AgentWorkbenchProps {
  readonly state: WireState;
  readonly snapshot: ShowSnapshot;
  readonly telemetry: TelemetrySnapshot;
  readonly timeline: readonly TimelineEntry[];
  readonly timelineTraceId: string | null;
  readonly timelinePending: boolean;
  readonly budget: Budget | null;
  readonly onLookupTrace: (traceId: string) => void;
}

/**
 * The right-hand stage. It answers four operator questions: what is the agent
 * doing, why, what happened to the last comment, and is the backend actually
 * reporting. Nothing on this surface is a placeholder video or a fake count.
 */
export function AgentWorkbench({
  state,
  snapshot,
  telemetry,
  budget,
  timeline,
  timelineTraceId,
  timelinePending,
  onLookupTrace,
}: AgentWorkbenchProps): React.JSX.Element {
  const groups = groupByTrace(telemetry.events);
  const latest = latestTraceGroup(groups);
  const work = currentWork(snapshot, telemetry.judgement);
  const steps = pipelineFor(latest);
  const goal = snapshot.goal;
  const timelineRef = useRef<HTMLElement | null>(null);
  const [replayRequest, setReplayRequest] = useState(0);

  const requestReplay = (traceId: string): void => {
    setReplayRequest((current) => current + 1);
    onLookupTrace(traceId);
  };

  useEffect(() => {
    if (replayRequest === 0 || timelinePending || timelineTraceId === null) return;
    // Smooth scrolling can be interrupted by the live event feed re-rendering
    // below the fold. The operator asked to see the replay; land there now.
    timelineRef.current?.scrollIntoView({ block: "start" });
  }, [replayRequest, timelinePending, timelineTraceId]);

  return (
    <main className="workbench" aria-label="Agent 可观测工作台">
      <header className="workbench__head">
        <div className="workbench__identity">
          <span className="workbench__signal" data-tone={work.tone} aria-hidden="true" />
          <div>
            <span className="workbench__eyebrow">Agent 可观测工作台</span>
            <h1>{work.label}</h1>
            <p>{work.detail}</p>
          </div>
        </div>
        <div className="workbench__head-facts">
          <Fact label="控制面" value={linkLabel(state)} tone={state === "open" ? "good" : "bad"} />
          <Fact
            label="身体"
            value={bridgeLabel(snapshot)}
            tone={snapshot.bridge?.connected ? "good" : "quiet"}
          />
          <Fact label="模式" value={modeLabel(snapshot.mode)} tone={snapshot.mode === "agent" ? "good" : "warn"} />
        </div>
      </header>

      <div className="workbench__grid">
        <section className="wb-card wb-card--focus" aria-labelledby="wb-focus">
          <CardHead id="wb-focus" title="当前判断" meta={telemetry.judgement ? "来自运行时" : "尚无判断"} />
          <JudgementPanel judgement={telemetry.judgement} snapshot={snapshot} />
        </section>

        <section className="wb-card wb-card--goal" aria-labelledby="wb-goal">
          <CardHead
            id="wb-goal"
            title="目标与里程碑"
            meta={goal === null ? "未建立" : `${goal.completed}/${goal.milestones.length} 已验证`}
          />
          <GoalPanel goal={goal} />
        </section>

        <section className="wb-card wb-card--pipeline" aria-labelledby="wb-pipeline">
          <CardHead
            id="wb-pipeline"
            title="处理链路"
            meta={latest?.traceId === null || latest === undefined ? "等待事件" : shortId(latest.traceId)}
          />
          <ol className="pipeline" aria-label="最近一条 trace 的处理阶段">
            {steps.map((step, index) => (
              <li key={step.stage} data-status={step.status} className="pipeline__step">
                <span className="pipeline__rail" aria-hidden="true" />
                <span className="pipeline__dot" aria-hidden="true" />
                <div>
                  <strong>{step.label}</strong>
                  <small>{pipelineMeta(step.status, step.at, step.durationMs)}</small>
                </div>
                {index < steps.length - 1 ? <span className="pipeline__arrow" aria-hidden="true" /> : null}
              </li>
            ))}
          </ol>
          {latest?.traceId ? (
            <button
              type="button"
              className="action action--ghost wb-link"
              onClick={() => requestReplay(latest.traceId!)}
            >
              {timelinePending ? "正在读取回放…" : `查看回放 ${shortId(latest.traceId)}`}
            </button>
          ) : (
            <p className="wb-empty">还没有可回放的评论。真实评论进入后，这里会生成 trace。</p>
          )}
        </section>

        <section className="wb-card wb-card--queue" aria-labelledby="wb-queue">
          <CardHead id="wb-queue" title="任务队列" meta={`${queueCount(snapshot.proposals)} 条待定`} />
          <QueuePanel snapshot={snapshot} telemetry={telemetry} />
        </section>

        <section className="wb-card wb-card--comments" aria-labelledby="wb-comments">
          <CardHead
            id="wb-comments"
            title="评论与决策"
            meta={
              ingressIsKnown(telemetry.ingress) && telemetry.ingress.received !== null
                ? `收到 ${telemetry.ingress.received}`
                : "Ingress 未上报"
            }
          />
          <CommentPanel
            decisions={snapshot.decisions}
            proposals={snapshot.proposals}
            ingress={telemetry.ingress}
            onLookupTrace={requestReplay}
          />
        </section>

        <section className="wb-card wb-card--voice" aria-labelledby="wb-voice">
          <CardHead id="wb-voice" title="模型、成本与语音" meta={voiceLabel(snapshot.voiceStatus)} />
          <VoicePanel voice={snapshot.voiceStatus} model={snapshot.model} budget={budget} />
        </section>

        <section className="wb-card wb-card--events" aria-labelledby="wb-events">
          <CardHead
            id="wb-events"
            title="实时事件"
            meta={`${telemetry.events.length} 条 · 最近${relativeTime(telemetry.events[0]?.at ?? null)}`}
          />
          <EventPanel groups={groups} onLookupTrace={requestReplay} />
        </section>

        {timelineTraceId !== null ? (
          <section
            ref={timelineRef}
            className="wb-card wb-card--timeline"
            aria-labelledby="wb-timeline"
          >
            <CardHead id="wb-timeline" title="回放时间轴" meta={shortId(timelineTraceId)} />
            <TimelinePanel entries={timeline} pending={timelinePending} />
          </section>
        ) : null}
      </div>
    </main>
  );
}

function Fact({
  label,
  value,
  tone,
}: {
  readonly label: string;
  readonly value: string;
  readonly tone: "good" | "warn" | "bad" | "quiet";
}): React.JSX.Element {
  return (
    <span className="wb-fact" data-tone={tone}>
      <span aria-hidden="true" />
      <small>{label}</small>
      <strong>{value}</strong>
    </span>
  );
}

function CardHead({
  id,
  title,
  meta,
}: {
  readonly id: string;
  readonly title: string;
  readonly meta: string;
}): React.JSX.Element {
  return (
    <header className="wb-card__head">
      <h2 id={id}>{title}</h2>
      <span>{meta}</span>
    </header>
  );
}

/**
 * A safe judgement summary. If the backend has not produced one, say so: the
 * console must not infer intent from a decision's raw text.
 */
function JudgementPanel({
  judgement,
  snapshot,
}: {
  readonly judgement: TelemetrySnapshot["judgement"];
  readonly snapshot: ShowSnapshot;
}): React.JSX.Element {
  if (judgement === null) {
    return (
      <div className="wb-empty wb-empty--tall">
        <strong>Agent 尚未给出判断</strong>
        <p>
          {snapshot.model?.state === "disabled"
            ? "模型未配置；规则仍会在本地给出确定性判断。"
            : "等待下一条评论或目标运行时产生可展示的判断摘要。"}
        </p>
      </div>
    );
  }
  return (
    <div className="judgement">
      <p className="judgement__summary">{judgement.summary}</p>
      <dl className="judgement__facts">
        <div>
          <dt>当前意图</dt>
          <dd>{judgement.intent || "未标注"}</dd>
        </div>
        <div>
          <dt>判断依据</dt>
          <dd>{judgement.reason || "未提供"}</dd>
        </div>
        <div>
          <dt>下一步</dt>
          <dd>{judgement.nextStep || "等待下一轮观察"}</dd>
        </div>
      </dl>
      <span className="judgement__confidence" data-confidence={judgement.confidence}>
        {judgement.confidence === "observed"
          ? "基于已观测事实"
          : judgement.confidence === "inferred"
            ? "基于模型推断"
            : "依据不足"}
      </span>
    </div>
  );
}

function GoalPanel({ goal }: { readonly goal: GoalProgress | null }): React.JSX.Element {
  if (goal === null) {
    return (
      <div className="wb-empty">
        <p>目标运行时还没有可验证的进度。</p>
        <small>在设置里建立目标后，阶段、里程碑和下一步会显示在这里。</small>
      </div>
    );
  }
  const progress = goalProgress(goal);
  return (
    <div className="goal">
      <div className="goal__row">
        <span className="goal__stage">{goal.stage.title}</span>
        <span className="goal__status" data-status={goal.status}>
          {goalStatusLabel(goal.status)}
        </span>
      </div>
      <p className="goal__milestone">{goal.milestone.title}</p>
      <div className="goal__meter" aria-label={progress.percent === null ? "里程碑未验证" : `里程碑完成 ${progress.percent}%`}>
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress.percent ?? 0}
          data-known={progress.percent !== null}
        >
          <span style={{ width: `${progress.percent ?? 0}%` }} />
        </div>
        <output>
          {progress.percent === null
            ? "未验证"
            : `${progress.completed}/${progress.total} · ${progress.percent}%`}
        </output>
      </div>
      <dl className="goal__facts">
        <div>
          <dt>下一步</dt>
          <dd>{goal.nextTask || "等待目标引擎给出任务"}</dd>
        </div>
        <div data-tone={goal.lastFailure === null ? undefined : "bad"}>
          <dt>最近失败</dt>
          <dd>{goal.lastFailure ?? "无"}</dd>
        </div>
        <div data-tone={goal.consecutiveFailures > 0 ? "warn" : undefined}>
          <dt>连续失败</dt>
          <dd>{goal.consecutiveFailures === 0 ? "0 次" : `${goal.consecutiveFailures} 次`}</dd>
        </div>
        <div>
          <dt>下次重试</dt>
          <dd>{goal.retryAt === null ? "无退避" : clock(goal.retryAt)}</dd>
        </div>
        <div>
          <dt>更新时间</dt>
          <dd>{clock(goal.updatedAt)}</dd>
        </div>
      </dl>
    </div>
  );
}

function QueuePanel({
  snapshot,
  telemetry,
}: {
  readonly snapshot: ShowSnapshot;
  readonly telemetry: TelemetrySnapshot;
}): React.JSX.Element {
  const pending = snapshot.proposals.filter((proposal) => proposal.status === "pending");
  const running = snapshot.decisions.filter(
    (decision) => decision.outcome == null && decision.skill !== null,
  );
  const failed = snapshot.decisions.filter(
    (decision) => decision.outcome?.status === "failed" || decision.outcome?.status === "timeout",
  );
  const failureEvents = telemetry.events.filter((event) => event.stage === "failed").length;
  return (
    <div className="queue">
      <dl className="queue__counts">
        <div><dt>运行中</dt><dd>{running.length}</dd></div>
        <div><dt>待仲裁</dt><dd>{pending.length}</dd></div>
        <div><dt>最近失败</dt><dd>{failed.length}</dd></div>
      </dl>
      <div className="queue__list">
        {pending.length === 0 ? (
          <p className="wb-empty-inline">没有等待决定的提议。</p>
        ) : (
          pending.slice(0, 4).map((proposal) => (
            <div className="queue__item" key={proposal.id}>
              <span>提议 · {proposal.intent}</span>
              <p>观众建议已进入收件箱</p>
              <small>{proposalGateLabel(proposal.status)}</small>
            </div>
          ))
        )}
      </div>
      <p className="queue__recovery">
        {failureEvents === 0
          ? "尚无失败事件；这不代表链路已通过完整验收。"
          : `最近窗口内记录到 ${failureEvents} 次失败。${
              snapshot.goal?.retryAt
                ? `下次重试 ${clock(snapshot.goal.retryAt)}。`
                : "当前没有排定的重试。"
            }`}
      </p>
    </div>
  );
}

/**
 * Ingress is the first stage operators need to trust. A missing backend
 * counter renders as "未上报", not as zero received or zero drops.
 */
function CommentPanel({
  decisions,
  proposals,
  ingress,
  onLookupTrace,
}: {
  readonly decisions: readonly Decision[];
  readonly proposals: readonly Proposal[];
  readonly ingress: IngressMetrics;
  readonly onLookupTrace: (traceId: string) => void;
}): React.JSX.Element {
  const muted = decisions.filter((decision) => decision.decision === "IGNORE" || decision.decision === "ACK_ONLY");
  const known = ingressIsKnown(ingress);
  return (
    <div className="comments">
      <div className="comments__health" data-state={ingress.state}>
        <div>
          <strong>{ingressLabel(ingress)}</strong>
          <small>{ingress.detail || "没有来自 Ingress 的说明"}</small>
        </div>
        <div className="comments__health-meta">
          <span>最近事件</span>
          <b>{relativeTime(ingress.lastEventAt)}</b>
        </div>
      </div>
      <dl className="comments__counts">
        <div><dt>收到</dt><dd>{numberOrUnknown(ingress.received, known)}</dd></div>
        <div><dt>转发</dt><dd>{numberOrUnknown(ingress.forwarded, known)}</dd></div>
        <div><dt>排队</dt><dd>{numberOrUnknown(ingress.queued, known)}</dd></div>
        <div><dt>丢弃</dt><dd>{numberOrUnknown(ingress.dropped, known)}</dd></div>
      </dl>
      {Object.keys(ingress.dropReasons).length > 0 ? (
        <ul className="comments__drops" aria-label="丢弃原因">
          {Object.entries(ingress.dropReasons).map(([reason, count]) => (
            <li key={reason}>
              <span>{reason}</span>
              <strong>{count}</strong>
            </li>
          ))}
        </ul>
      ) : (
        <p className="comments__note">
          {known ? "当前没有记录到丢弃原因。" : "Ingress 尚未上报指标，丢弃原因未知。"}
        </p>
      )}
      <div className="comments__latest">
        {decisions.length === 0 ? (
          <p className="wb-empty-inline">
            {proposals.length === 0
              ? "还没有评论进入。接入抖音后将显示真实吞吐和决策。"
              : "评论已进入提议收件箱，等待闸门。"}
          </p>
        ) : (
          decisions.slice(0, 3).map((decision) => (
            <button
              key={decision.id}
              type="button"
              className="comment-row"
              onClick={() => onLookupTrace(decision.eventId)}
            >
              <span className="comment-row__decision" data-kind={decision.decision}>
                {decisionLabel(decision.decision)}
              </span>
              <span className="comment-row__body">
                <strong>{decisionOutcomeLine(decision)}</strong>
                <small>
                  {decision.intent} · {decisionLabel(decision.decision)}
                  {decision.outcome === null ? " · 终态未知" : ""}
                </small>
              </span>
              <time>{clock(decision.at)}</time>
            </button>
          ))
        )}
      </div>
      {muted.length > 0 ? <p className="comments__note">最近窗口有 {muted.length} 条仅回应/忽略。</p> : null}
    </div>
  );
}

function VoicePanel({
  voice,
  model,
  budget,
}: {
  readonly voice: VoiceStatus | null;
  readonly model: ShowSnapshot["model"];
  readonly budget: Budget | null;
}): React.JSX.Element {
  return (
    <div className="voice-panel">
      <div className="voice-panel__model">
        <span data-state={model?.state ?? "disabled"} />
        <div>
          <strong>{modelLabel(model)}</strong>
          <small>{model?.detail || "没有模型连接说明"}</small>
        </div>
        {model?.model ? <code>{model.model}</code> : null}
      </div>
      <dl className="voice-panel__budget">
        <div>
          <dt>本小时成本</dt>
          <dd>{budget === null ? "未上报" : budget.spent.toFixed(4)}</dd>
        </div>
        <div>
          <dt>降级状态</dt>
          <dd>{budget === null ? "未知" : budget.degraded ? "已降级" : "未触发"}</dd>
        </div>
      </dl>
      {voice === null ? (
        <div className="wb-empty">
          <p>语音服务未上报状态。</p>
          <small>未接入时不会显示“正常”或虚构延迟。</small>
        </div>
      ) : (
        <>
          <div className="voice-panel__state">
            <span data-state={voice.state} />
            <strong>{voiceLabel(voice)}</strong>
            <small>{voice.detail || "没有额外说明"}</small>
          </div>
          <dl className="voice-panel__counts">
            <div><dt>已说</dt><dd>{voice.spoken}</dd></div>
            <div><dt>排队</dt><dd>{voice.queued}</dd></div>
            <div><dt>失败</dt><dd>{voice.failed}</dd></div>
            <div><dt>取消</dt><dd>{voice.cancelled}</dd></div>
          </dl>
          <p className="comments__note">
            {voice.lastSpokenAt === null
              ? "本场还没有成功播报。"
              : `最近播报 ${relativeTime(voice.lastSpokenAt)}。`}
          </p>
        </>
      )}
    </div>
  );
}

function EventPanel({
  groups,
  onLookupTrace,
}: {
  readonly groups: readonly TraceGroup[];
  readonly onLookupTrace: (traceId: string) => void;
}): React.JSX.Element {
  if (groups.length === 0) {
    return (
      <div className="wb-empty">
        <p>控制面还没有上报事件。</p>
        <small>这不是“一切正常”，只是尚无可展示的事实。</small>
      </div>
    );
  }
  // A single trace can carry hundreds of retried/dropped frames. Rendering
  // every row makes the workbench thousands of pixels tall and pushes the
  // replay card away while the operator is looking at it. Keep the newest
  // groups and the newest rows per group; the full history stays in SQLite.
  const visibleGroups = groups.slice(0, 5);
  return (
    <ol className="event-feed" aria-label="最近事件组">
      {visibleGroups.map((group) => {
        const visibleEvents = group.events.slice(-4);
        const hidden = group.events.length - visibleEvents.length;
        return (
        <li key={group.traceId ?? group.events[0]!.id} className="event-group">
          <div className="event-group__head">
            <span className="event-group__trace">
              {group.traceId === null ? "系统事件" : shortId(group.traceId)}
            </span>
            <span className="event-group__time">{clock(group.lastAt)}</span>
            {group.terminal !== null ? (
              <span className="event-group__status" data-status={group.terminal}>
                {STATUS_LABELS[group.terminal]}
              </span>
            ) : null}
          </div>
          <ul className="event-group__stages">
            {visibleEvents.map((event) => (
              <li key={event.id} data-status={event.status}>
                <span>{STAGE_LABELS[event.stage]}</span>
                <p>{event.summary || "没有摘要"}</p>
                <small>
                  {EVENT_SOURCES[event.source]}
                  {event.durationMs === null ? "" : ` · ${event.durationMs}ms`}
                  {event.errorCode === null ? "" : ` · ${event.errorCode}`}
                </small>
              </li>
            ))}
          </ul>
          {hidden > 0 ? (
            <p className="event-group__more">更早 {hidden} 条已收起，可在回放中查看。</p>
          ) : null}
          {group.traceId !== null ? (
            <button
              type="button"
              className="event-group__link"
              onClick={() => onLookupTrace(group.traceId!)}
            >
              查看 trace →
            </button>
          ) : null}
        </li>
        );
      })}
    </ol>
  );
}

function TimelinePanel({
  entries,
  pending,
}: {
  readonly entries: readonly TimelineEntry[];
  readonly pending: boolean;
}): React.JSX.Element {
  if (pending) return <p className="wb-empty-inline">正在读取 SQLite 回放…</p>;
  if (entries.length === 0) {
    return <p className="wb-empty-inline">这个 trace 没有可回放的持久化记录。</p>;
  }
  return (
    <ol className="timeline">
      {entries.map((entry, index) => (
        <li key={`${entry.kind}-${index}`} data-kind={entry.kind}>
          <span className="timeline__kind">{entry.kind}</span>
          <div>
            <strong>{timelineSummary(entry)}</strong>
            <small>{clock(entry.at)}</small>
          </div>
        </li>
      ))}
    </ol>
  );
}

function timelineSummary(entry: TimelineEntry): string {
  switch (entry.kind) {
    case "source":
      return `${entry.eventKind} · 来源 ${entry.sourceId} · 原文不进入管理端`;
    case "decision":
      return `${decisionLabel(entry.decision)} · 意图 ${entry.intent}${entry.skill ? ` · ${entry.skill}` : ""}`;
    case "commitment":
      return `${entry.status} · 承诺 ${entry.commitmentId}`;
    case "action":
      return `${entry.skill} · ${entry.status}${entry.errorCode === null ? "" : ` · ${entry.errorCode}`}`;
  }
}

function pipelineMeta(
  status: AgentEventStatus | "pending",
  at: number | null,
  durationMs: number | null,
): string {
  if (status === "pending") return "尚未到达";
  const label = status === "skipped" ? "已跳过" : STATUS_LABELS[status];
  const time = at === null ? "" : ` · ${clock(at)}`;
  const duration = durationMs === null ? "" : ` · ${durationMs}ms`;
  return `${label}${time}${duration}`;
}

function linkLabel(state: WireState): string {
  if (state === "open") return "在线";
  if (state === "connecting") return "连接中";
  return state === "error" ? "错误" : "离线";
}

function bridgeLabel(snapshot: ShowSnapshot): string {
  if (!snapshot.bridge?.connected) return "未接入";
  return snapshot.bridge.world?.inWorld ? "世界中" : "已连接";
}

function ingressLabel(ingress: IngressMetrics): string {
  switch (ingress.state) {
    case "open":
      return "抖音评论在线";
    case "connecting":
      return "抖音连接中";
    case "closed":
      return "Ingress 已停止";
    case "error":
      return "Ingress 异常";
    case "not_configured":
      return "未配置抖音房间";
    default:
      return "Ingress 状态未知";
  }
}

function modelLabel(model: ShowSnapshot["model"]): string {
  if (model === null) return "模型未上报";
  switch (model.state) {
    case "ready":
      return "模型已连接";
    case "error":
      return "模型连接失败";
    case "unverified":
      return "模型未验证";
    default:
      return "模型未配置";
  }
}

function numberOrUnknown(value: number | null, known: boolean): string {
  return known && value !== null ? String(value) : "未上报";
}

function goalStatusLabel(status: GoalProgress["status"]): string {
  switch (status) {
    case "active":
      return "运行中";
    case "paused":
      return "已暂停";
    case "blocked":
      return "受阻";
    case "completed":
      return "已完成";
    case "failed":
      return "失败";
    default:
      return "未验证";
  }
}

function decisionLabel(kind: Decision["decision"]): string {
  switch (kind) {
    case "EXECUTE":
      return "执行";
    case "REFUSE":
      return "拒绝";
    case "QUEUE":
      return "排队";
    case "ACK_ONLY":
      return "回应";
    case "OBSERVE":
      return "观察";
    default:
      return "忽略";
  }
}

/**
 * Decision reasons can contain model prose or quoted audience input. The
 * workbench uses the structured kind and outcome instead; the full row stays
 * in SQLite for replay and audit.
 */
function decisionOutcomeLine(decision: Decision): string {
  if (decision.outcome == null) {
    return decision.skill === null
      ? `规则判断：${decisionLabel(decision.decision)}`
      : `已授权 ${decision.skill.name}，等待终态`;
  }
  const outcome = decision.outcome;
  switch (outcome.status) {
    case "completed":
      return `${decision.skill?.name ?? "动作"} 已完成`;
    case "timeout":
      return "动作超时，终态未知";
    case "cancelled":
      return "动作已取消";
    case "preempted":
      return "动作被更高优先级任务顶替";
    default:
      return `动作失败${outcome.errorCode ? ` · ${outcome.errorCode}` : ""}`;
  }
}

function proposalGateLabel(status: Proposal["status"]): string {
  switch (status) {
    case "accepted":
      return "已通过提议闸门";
    case "deferred":
      return "已延后，保留到安全窗口";
    case "rejected":
      return "安全或目标闸门拒绝";
    case "clarify":
      return "缺少可执行动作，等待澄清";
    default:
      return "等待目标一致性评估";
  }
}

function shortId(value: string): string {
  return value.length <= 12 ? value : `${value.slice(0, 8)}…${value.slice(-3)}`;
}

