import { useEffect, useRef, useState, type FormEvent } from "react";
import type {
  BodyEvent,
  OperatorKind,
  ProposalStatus,
  ShowSnapshot,
  TelemetrySnapshot,
} from "@craftmate/contracts";
import type { WireState } from "../../lib/connection.ts";
import {
  buildAgentChat,
  humanizeRuntimeText,
  type AgentChatEntry,
  type ChatMeta,
  type ChatTone,
} from "../../lib/agent-chat-view.ts";
import {
  currentWork,
  goalProgress,
  ingressIsKnown,
  queueCount,
} from "../../lib/telemetry-view.ts";
import { clock } from "../../lib/format.ts";
import mascot from "../../assets/dafeiyu.png";

interface AgentWorkbenchProps {
  readonly state: WireState;
  readonly snapshot: ShowSnapshot;
  readonly telemetry: TelemetrySnapshot;
  readonly worldEvents: readonly BodyEvent[];
  readonly personaName: string;
  readonly disabled: boolean;
  readonly onComment: (nickname: string, text: string) => void;
  readonly onOperator: (kind: OperatorKind, text?: string) => void;
  readonly onDecideProposal: (
    proposalId: string,
    status: Exclude<ProposalStatus, "pending">,
    reason: string,
  ) => void;
  readonly onLookupTrace: (traceId: string) => void;
}

interface WorkPresentation {
  readonly label: string;
  readonly detail: string;
  readonly tone: ChatTone;
}

/**
 * The default stage is a conversation, not a dashboard. Live ingress and the
 * current physical task stay visible as two compact facts; decisions, body
 * events and audience proposals share the same chronological transcript.
 */
export function AgentWorkbench({
  state,
  snapshot,
  telemetry,
  worldEvents,
  personaName,
  disabled,
  onComment,
  onOperator,
  onDecideProposal,
  onLookupTrace,
}: AgentWorkbenchProps): React.JSX.Element {
  const conversation = buildAgentChat(snapshot, telemetry, worldEvents);
  const work = workPresentation(snapshot, currentWork(snapshot, telemetry.judgement));
  const presence = agentPresence(state, snapshot);
  const threadRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const thread = threadRef.current;
    if (thread === null) return;
    const stickToLatest = (): void => {
      thread.scrollTop = thread.scrollHeight;
    };
    stickToLatest();
    const observer = new ResizeObserver(stickToLatest);
    observer.observe(thread);
    const content = thread.firstElementChild;
    if (content !== null) observer.observe(content);
    return () => observer.disconnect();
  }, []);

  return (
    <main className="agent-chat" aria-label="Agent 直播对话">
      <header className="agent-chat__header">
        <div className="agent-chat__identity">
          <span className="agent-chat__avatar" aria-hidden="true">
            <img src={mascot} alt="" />
          </span>
          <div className="agent-chat__identity-copy">
            <div className="agent-chat__name-line">
              <h1>{personaName || "大肥鱼"}</h1>
              <span className="agent-chat__presence" data-tone={presence.tone}>
                {presence.label}
              </span>
            </div>
          </div>
        </div>
      </header>

      <section className="agent-chat__dock" aria-label="直播接入与当前执行">
        <LiveConnectionCard snapshot={snapshot} telemetry={telemetry} />
        <CurrentWorkCard snapshot={snapshot} work={work} />
      </section>

      <div className="agent-chat__conversation" ref={threadRef}>
        <div className="agent-chat__thread">
          {conversation.length === 0 ? (
            <EmptyConversation />
          ) : (
            conversation.map((entry) => (
              <ChatTurn
                key={entry.id}
                entry={entry}
                personaName={personaName || "大肥鱼"}
                disabled={disabled}
                onDecideProposal={onDecideProposal}
                onLookupTrace={onLookupTrace}
              />
            ))
          )}
        </div>
      </div>

      <AgentComposer
        personaName={personaName || "大肥鱼"}
        disabled={disabled}
        onComment={onComment}
        onOperator={onOperator}
      />
    </main>
  );
}

function LiveConnectionCard({
  snapshot,
  telemetry,
}: {
  readonly snapshot: ShowSnapshot;
  readonly telemetry: TelemetrySnapshot;
}): React.JSX.Element {
  const ingress = telemetry.ingress;
  const known = ingressIsKnown(ingress);
  const counts = [
    ["评论", known && ingress.received !== null ? String(ingress.received) : "—"],
    ["执行", String(snapshot.stats.executed)],
    ["待处理", String(queueCount(snapshot.proposals))],
  ] as const;
  return (
    <article className="agent-chat__dock-card agent-chat__dock-card--live">
      <header>
        <span className="agent-chat__dock-label">直播接入</span>
        <strong data-tone={ingressTone(ingress.state)}>
          {ingressLabel(telemetry.ingress)}
        </strong>
      </header>
      <dl className="agent-chat__counts">
        {counts.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </article>
  );
}

function CurrentWorkCard({
  snapshot,
  work,
}: {
  readonly snapshot: ShowSnapshot;
  readonly work: WorkPresentation;
}): React.JSX.Element {
  const goal = snapshot.goal;
  const progress = goalProgress(goal);
  return (
    <article className="agent-chat__dock-card agent-chat__dock-card--work">
      <header>
        <span className="agent-chat__dock-label">当前执行</span>
      </header>
      <p className="agent-chat__work-title">{humanizeRuntimeText(work.label)}</p>
      <p className="agent-chat__dock-detail">{humanizeRuntimeText(work.detail)}</p>
      <div className="agent-chat__work-meta">
        <span>
          {goal === null
            ? "未建立今日主线"
            : `${goal.stage.title} · ${progress.completed}/${progress.total} 已验证`}
        </span>
        {goal?.nextTask ? <span>下一步 {goal.nextTask}</span> : null}
      </div>
      {goal?.playbook ? (
        <div className="agent-chat__work-meta" data-playbook="true">
          <span>
            玩法卡 {goal.playbook.cardTitle} ·{" "}
            {goal.playbook.modelChoice === true ? "模型选择" : "确定性回退"} ·{" "}
            已执行 {Math.floor(goal.playbook.activeForMs / 1000)}s ·{" "}
            {goal.playbook.minDwellRemainingMs > 0
              ? `驻留剩余 ${Math.ceil(goal.playbook.minDwellRemainingMs / 1000)}s`
              : "可换卡"}
          </span>
          {goal.playbook.cardReason ? (
            <span>{humanizeRuntimeText(goal.playbook.cardReason)}</span>
          ) : null}
          {goal.playbook.failureCode ? (
            <span>
              最近失败 {goal.playbook.failureCode}
              {goal.playbook.recoveryId
                ? ` · 恢复卡 ${goal.playbook.recoveryId}`
                : ""}
            </span>
          ) : null}
          {goal.playbook.fallbackReason ? (
            <span>回退原因 {humanizeRuntimeText(goal.playbook.fallbackReason)}</span>
          ) : null}
          {goal.playbook.alternatives
            .filter((item) => item.status === "blocked")
            .slice(0, 3)
            .map((item) => (
              <span key={item.id}>
                受阻 · {item.title}
                {item.blockedReason ? `：${humanizeRuntimeText(item.blockedReason)}` : ""}
              </span>
            ))}
        </div>
      ) : null}
    </article>
  );
}

function ChatTurn({
  entry,
  personaName,
  disabled,
  onDecideProposal,
  onLookupTrace,
}: {
  readonly entry: AgentChatEntry;
  readonly personaName: string;
  readonly disabled: boolean;
  readonly onDecideProposal: (
    proposalId: string,
    status: Exclude<ProposalStatus, "pending">,
    reason: string,
  ) => void;
  readonly onLookupTrace: (traceId: string) => void;
}): React.JSX.Element {
  if (entry.kind === "system") {
    return (
      <div className="agent-chat__system" data-tone={entry.tone}>
        <p>{entry.text}</p>
        <time>{clock(entry.at)}</time>
      </div>
    );
  }
  if (entry.kind === "proposal") {
    return (
      <article className="agent-chat__turn agent-chat__turn--audience agent-chat__turn--proposal">
        <div className="agent-chat__message">
          <header>
            <strong>{entry.speaker}</strong>
            <time>{clock(entry.at)}</time>
            {entry.traceId !== null ? (
              <TraceButton traceId={entry.traceId} onLookupTrace={onLookupTrace} />
            ) : null}
          </header>
          <div className="agent-chat__bubble agent-chat__bubble--audience agent-chat__bubble--proposal">
            <p>{entry.text}</p>
            <MetaRows meta={entry.meta} />
            {entry.status === "pending" ? (
              <div className="agent-chat__proposal-actions">
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() =>
                    onDecideProposal(
                      entry.proposalId,
                      "accepted",
                      "操作员在对话中采纳了这条观众提议。",
                    )
                  }
                >
                  采纳
                </button>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() =>
                    onDecideProposal(
                      entry.proposalId,
                      "deferred",
                      "操作员选择稍后处理这条观众提议。",
                    )
                  }
                >
                  稍后
                </button>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() =>
                    onDecideProposal(
                      entry.proposalId,
                      "rejected",
                      "操作员暂不采纳这条观众提议。",
                    )
                  }
                >
                  拒绝
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </article>
    );
  }
  if (entry.kind === "audience") {
    return (
      <article className="agent-chat__turn agent-chat__turn--audience">
        <div className="agent-chat__message">
          <header>
            <strong>{entry.speaker}</strong>
            <time>{clock(entry.at)}</time>
            {entry.traceId !== null ? (
              <TraceButton traceId={entry.traceId} onLookupTrace={onLookupTrace} />
            ) : null}
          </header>
          <div className="agent-chat__bubble agent-chat__bubble--audience">
            <p>{entry.text}</p>
            <MetaRows meta={entry.meta} />
          </div>
        </div>
      </article>
    );
  }
  return (
    <article className="agent-chat__turn agent-chat__turn--agent">
      <img className="agent-chat__message-avatar" src={mascot} alt="" aria-hidden="true" />
      <div className="agent-chat__message">
        <header>
          <strong>{personaName}</strong>
          {entry.current ? <span className="agent-chat__now">现在</span> : null}
          <time>{clock(entry.at)}</time>
          {entry.traceId !== null ? (
            <TraceButton traceId={entry.traceId} onLookupTrace={onLookupTrace} />
          ) : null}
        </header>
        <div className="agent-chat__bubble" data-tone={entry.tone}>
          <p>{entry.text}</p>
          <MetaRows meta={entry.meta} />
        </div>
      </div>
    </article>
  );
}

function MetaRows({ meta }: { readonly meta: readonly ChatMeta[] }): React.JSX.Element | null {
  if (meta.length === 0) return null;
  return (
    <dl className="agent-chat__meta">
      {meta.map((item, index) => (
        <div key={`${item.label}-${index}`} data-tone={item.tone}>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function TraceButton({
  traceId,
  onLookupTrace,
}: {
  readonly traceId: string;
  readonly onLookupTrace: (traceId: string) => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      className="agent-chat__trace"
      title={`查看 ${traceId} 的完整回放`}
      onClick={() => onLookupTrace(traceId)}
    >
      回放
    </button>
  );
}

function AgentComposer({
  personaName,
  disabled,
  onComment,
  onOperator,
}: {
  readonly personaName: string;
  readonly disabled: boolean;
  readonly onComment: (nickname: string, text: string) => void;
  readonly onOperator: (kind: OperatorKind, text?: string) => void;
}): React.JSX.Element {
  const [text, setText] = useState("");

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const value = text.trim();
    if (value.length === 0) return;
    onComment("你", value);
    setText("");
  };

  return (
    <footer className="agent-chat__composer">
      <form className="agent-chat__composer-form" onSubmit={submit}>
        <input
          id="agent-message"
          value={text}
          onChange={(event) => setText(event.target.value)}
          aria-label={`和 ${personaName} 说点什么`}
          placeholder={`和 ${personaName} 说点什么…`}
          disabled={disabled}
          autoComplete="off"
          maxLength={500}
        />
        <button type="submit" disabled={disabled || text.trim().length === 0}>
          发送
        </button>
      </form>
      <div className="agent-chat__composer-tools">
        <div>
          <button
            type="button"
            disabled={disabled}
            onClick={() => onOperator("takeover", "操作员接管")}
          >
            接管
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={() => onOperator("release", "操作员释放")}
          >
            交还
          </button>
          <button
            type="button"
            data-danger="true"
            disabled={disabled}
            onClick={() => onOperator("stop", "急停")}
          >
            急停
          </button>
        </div>
      </div>
    </footer>
  );
}

function EmptyConversation(): React.JSX.Element {
  return (
    <div className="agent-chat__empty">
      <strong>还没有对话</strong>
      <p>收到弹幕后会显示在这里。</p>
    </div>
  );
}

function workPresentation(
  snapshot: ShowSnapshot,
  work: ReturnType<typeof currentWork>,
): WorkPresentation {
  if (snapshot.mode === "stopped") {
    return {
      label: "Agent 已急停",
      detail: "动作和语音已停止，等待操作员显式恢复。",
      tone: "bad",
    };
  }
  if (snapshot.mode === "operator") {
    return {
      label: "操作员接管中",
      detail: "Agent 暂停动作，只保留观察和评论判断。",
      tone: "warn",
    };
  }
  if (snapshot.goal?.status === "paused") {
    return {
      label: "主线暂停",
      detail: `当前停在「${snapshot.goal.stage.title}」，新弹幕会进入提议收件箱。`,
      tone: "warn",
    };
  }
  if (snapshot.goal?.status === "blocked") {
    return {
      label: `受阻 · ${snapshot.goal.stage.title}`,
      detail: "Agent 会重新观察环境，再决定下一步。",
      tone: "bad",
    };
  }
  const latest = snapshot.decisions[0];
  const staleJudgement =
    (snapshot.bridge?.running ?? 0) === 0 &&
    latest !== undefined &&
    Date.now() - latest.at > 120_000;
  if (staleJudgement) {
    return snapshot.goal?.nextTask
      ? {
          label: snapshot.goal.nextTask,
          detail: `停在「${snapshot.goal.stage.title}」，等待下一次观察。`,
          tone: "quiet",
        }
      : {
          label: "观察中",
          detail: "最近没有新的动作或判断，Agent 正在等待下一条弹幕。",
          tone: "quiet",
        };
  }
  return {
    label: work.label,
    detail: work.detail,
    tone: work.tone === "live" ? "live" : work.tone === "bad" ? "bad" : work.tone === "waiting" ? "warn" : "quiet",
  };
}

function agentPresence(
  state: WireState,
  snapshot: ShowSnapshot,
): { readonly label: string; readonly tone: ChatTone } {
  if (state === "connecting") {
    return { label: "正在连接", tone: "warn" };
  }
  if (state !== "open") {
    return { label: "内核离线", tone: "bad" };
  }
  if (snapshot.mode === "operator") {
    return { label: "操作员接管", tone: "warn" };
  }
  if (snapshot.mode === "stopped") {
    return { label: "已急停", tone: "bad" };
  }
  if (snapshot.goal?.status === "paused") {
    return { label: "目标暂停", tone: "warn" };
  }
  if (snapshot.goal?.status === "blocked") {
    return { label: "目标受阻", tone: "bad" };
  }
  if (snapshot.goal !== null) {
    return { label: "自主直播中", tone: "live" };
  }
  return { label: "待命中", tone: "quiet" };
}

function ingressTone(state: TelemetrySnapshot["ingress"]["state"]): ChatTone {
  if (state === "open") return "good";
  if (state === "connecting" || state === "not_configured") return "warn";
  if (state === "error") return "bad";
  return "quiet";
}

function ingressLabel(ingress: TelemetrySnapshot["ingress"]): string {
  switch (ingress.state) {
    case "open":
      return "抖音评论在线";
    case "connecting":
      return "连接中";
    case "closed":
      return "已停止";
    case "error":
      return "接入异常";
    case "not_configured":
      return "未配置抖音房间";
    default:
      return "状态未知";
  }
}

