import { useState } from "react";
import type { TimelineEntry } from "@craftmate/contracts";

interface ReplayViewProps {
  readonly entries: readonly TimelineEntry[];
  readonly pending: boolean;
  readonly onLookup: (traceId: string) => void;
}

const LABELS: Record<TimelineEntry["kind"], string> = {
  source: "来源",
  decision: "决策",
  commitment: "承诺",
  action: "动作",
};

/**
 * Replay is a lookup, not a scrubber: the operator arrives with a trace id
 * from a decision row or a commitment, and sees the whole chain in order.
 */
export function ReplayView({ entries, pending, onLookup }: ReplayViewProps): React.JSX.Element {
  const [traceId, setTraceId] = useState("");

  return (
    <div className="replay-view">
      <form
        className="voice-preview"
        onSubmit={(event) => {
          event.preventDefault();
          if (traceId.trim().length > 0) onLookup(traceId.trim());
        }}
      >
        <input
          className="input"
          value={traceId}
          placeholder="输入 traceId 或平台事件 id"
          aria-label="traceId"
          onChange={(event) => setTraceId(event.target.value)}
        />
        <button type="submit" className="action" disabled={pending || traceId.trim().length === 0}>
          {pending ? "查询中" : "查询"}
        </button>
      </form>

      {entries.length === 0 ? (
        <p className="panel-note">没有记录。先发一条评论，再用它的事件 id 查询。</p>
      ) : (
        <ol className="timeline">
          {entries.map((entry) => (
            <li key={`${entry.kind}-${entry.at}-${describeId(entry)}`} data-kind={entry.kind}>
              <span className="timeline__kind">{LABELS[entry.kind]}</span>
              <div>
                <strong>{describe(entry)}</strong>
                <small>{new Date(entry.at).toLocaleString("zh-CN")}</small>
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function describeId(entry: TimelineEntry): string {
  switch (entry.kind) {
    case "source":
      return entry.sourceId;
    case "decision":
      return entry.decisionId;
    case "commitment":
      return `${entry.commitmentId}:${entry.status}`;
    case "action":
      return entry.actionId;
    default:
      return "";
  }
}

function describe(entry: TimelineEntry): string {
  switch (entry.kind) {
    case "source":
      return `${entry.eventKind} · 来源 ${entry.sourceId} · 原文仅在数据库留存`;
    case "decision":
      return `${entry.decision} · ${entry.intent} · ${entry.stage}${entry.skill ? ` · ${entry.skill}` : ""}${entry.provider ? ` · ${entry.provider}/${entry.model}` : ""}`;
    case "commitment":
      return `${entry.status} · 承诺 ${entry.commitmentId} · 语音原文不进入管理端`;
    case "action":
      return `${entry.skill} · ${entry.status}${entry.errorCode ? ` · ${entry.errorCode}` : ""}`;
    default:
      return "";
  }
}
