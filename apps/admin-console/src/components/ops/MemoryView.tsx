import type { Memory, ReviewCandidate } from "@craftmate/contracts";

interface MemoryViewProps {
  readonly memories: readonly Memory[];
  readonly candidates: readonly ReviewCandidate[];
  readonly disabled: boolean;
  readonly onApprove: (candidateId: string) => void;
  readonly onReject: (candidateId: string, reason: string) => void;
  readonly onForget: (memoryId: string) => void;
}

/**
 * Review queue first, then approved memory. A pending candidate is visibly
 * *not* recallable, so nobody assumes approval is a formality.
 */
export function MemoryView({
  memories,
  candidates,
  disabled,
  onApprove,
  onReject,
  onForget,
}: MemoryViewProps): React.JSX.Element {
  return (
    <div className="memory-view">
      <section aria-labelledby="pending-title">
        <h3 id="pending-title">待审记忆 · {candidates.length}</h3>
        {candidates.length === 0 ? (
          <p className="panel-note">暂无待审条目。</p>
        ) : (
          <ul className="ops-list">
            {candidates.map((candidate) => {
              const content = candidate.payload as { content?: unknown; subjectRef?: unknown };
              return (
                <li key={candidate.id} className="ops-item">
                  <div>
                    <strong>{String(content.content ?? "（无内容）")}</strong>
                    <small>
                      {candidate.kind} · 对象 {String(content.subjectRef ?? "—")} ·{" "}
                      {new Date(candidate.createdAt).toLocaleString("zh-CN")}
                    </small>
                  </div>
                  <div className="ops-actions">
                    <button type="button" className="action" disabled={disabled} onClick={() => onApprove(candidate.id)}>
                      批准
                    </button>
                    <button
                      type="button"
                      className="action action--ghost"
                      disabled={disabled}
                      onClick={() => onReject(candidate.id, "操作员驳回")}
                    >
                      驳回
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section aria-labelledby="approved-title">
        <h3 id="approved-title">已批准 · {memories.length}</h3>
        {memories.length === 0 ? (
          <p className="panel-note">暂无长期记忆。</p>
        ) : (
          <ul className="ops-list">
            {memories.map((memory) => (
              <li key={memory.id} className="ops-item">
                <div>
                  <strong>{memory.content}</strong>
                  <small>
                    {memory.family} · 置信 {memory.confidence.toFixed(2)} · 披露 {memory.disclosure} ·{" "}
                    证据 {memory.evidenceSourceIds.length} · 成功 {memory.successCount} / 失败{" "}
                    {memory.failureCount}
                  </small>
                  {memory.conditions === null && memory.applicableVersion === null ? null : (
                    <small>
                      {memory.applicableVersion === null
                        ? ""
                        : `适用版本 ${memory.applicableVersion}`}
                      {memory.applicableVersion !== null && memory.conditions !== null
                        ? " · "
                        : ""}
                      {memory.conditions === null ? "" : `失败条件：${memory.conditions}`}
                    </small>
                  )}
                </div>
                <button
                  type="button"
                  className="action action--ghost"
                  disabled={disabled || memory.state !== "active"}
                  onClick={() => onForget(memory.id)}
                >
                  遗忘
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
