import type { ShowSettings } from "@craftmate/contracts";
import type { OpsSnapshot } from "@craftmate/contracts";
import { useState } from "react";
import { MemoryView } from "./MemoryView.tsx";

interface OpsViewProps {
  readonly ops: OpsSnapshot | null;
  readonly settings: ShowSettings | null;
  readonly disabled: boolean;
  readonly onApprove: (candidateId: string) => void;
  readonly onReject: (candidateId: string, reason: string) => void;
  readonly onForget: (memoryId: string) => void;
  readonly onUpdateWorldMemory: (
    memory: import("@craftmate/contracts").WorldMemoryUpdate,
  ) => void;
  readonly onForgetWorldMemory: (memoryId: string) => void;
  readonly onForgetStrategyMemory: (memoryId: string) => void;
  readonly onForgetRouteBlacklist: (blacklistId: string) => void;
  readonly onActivate: (versionId: string) => void;
}

const WEIGHT_LABELS = [
  ["obedience", "听话"],
  ["risk", "冒险"],
  ["sass", "嘴硬"],
  ["patience", "耐心"],
  ["gluttony", "贪吃"],
] as const;

/**
 * Memory, persona history and budget in one panel. Version contents render as
 * a diff against the active persona, because "which number changed" is the
 * only question an operator asks before a rollback.
 */
export function OpsView({
  ops,
  settings,
  disabled,
  onApprove,
  onReject,
  onForget,
  onUpdateWorldMemory,
  onForgetWorldMemory,
  onForgetStrategyMemory,
  onForgetRouteBlacklist,
  onActivate,
}: OpsViewProps): React.JSX.Element {
  if (!ops) {
    return <p className="panel-note">正在读取…</p>;
  }

  const active = settings?.persona;
  const versions = ops.personaVersions;
  const worldMemories = ops.worldMemories ?? [];
  const strategyMemories = ops.strategyMemories ?? [];
  const routeBlacklists = ops.routeBlacklists ?? [];

  return (
    <div className="ops-view">
      <section aria-labelledby="budget-title">
        <h3 id="budget-title">成本</h3>
        <dl className="decision-summary">
          <div><dt>本小时</dt><dd>{ops.budget.spent.toFixed(2)}</dd></div>
          <div><dt>上限</dt><dd>{ops.budget.hourlyLimit > 0 ? ops.budget.hourlyLimit : "未设"}</dd></div>
          <div><dt>状态</dt><dd>{ops.budget.degraded ? "已降级" : "正常"}</dd></div>
        </dl>
        {ops.budget.detail ? <p className="panel-note">{ops.budget.detail}</p> : null}
      </section>

      <MemoryView
        memories={ops.memories}
        candidates={ops.candidates}
        disabled={disabled}
        onApprove={onApprove}
        onReject={onReject}
        onForget={onForget}
      />

      <WorldMemoryView
        memories={worldMemories}
        disabled={disabled}
        onUpdate={onUpdateWorldMemory}
        onForget={onForgetWorldMemory}
      />

      <section aria-labelledby="strategy-memory-title">
        <h3 id="strategy-memory-title">策略记忆 · {strategyMemories.length}</h3>
        {strategyMemories.length === 0 ? (
          <p className="panel-note">还没有跨会话策略结果。</p>
        ) : (
          <ul className="ops-list">
            {strategyMemories.slice(0, 20).map((memory) => (
              <li key={memory.id} className="ops-item">
                <div>
                  <strong>
                    {memory.cardId ?? memory.stage} · 成功 {memory.successCount} / 失败{" "}
                    {memory.failureCount}
                  </strong>
                  <small>
                    {memory.lastFailureCode
                      ? `${memory.lastFailureCode}：${memory.lastFailureDetail ?? ""}`
                      : "最近没有失败"}
                  </small>
                </div>
                <button
                  type="button"
                  className="action action--ghost"
                  disabled={disabled}
                  onClick={() => onForgetStrategyMemory(memory.id)}
                >
                  忘记
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="route-blacklist-title">
        <h3 id="route-blacklist-title">路线黑名单 · {routeBlacklists.length}</h3>
        {routeBlacklists.length === 0 ? (
          <p className="panel-note">当前没有被拉黑的坐标、实体或危险区域。</p>
        ) : (
          <ul className="ops-list">
            {routeBlacklists.slice(0, 30).map((entry) => (
              <li key={entry.id} className="ops-item">
                <div>
                  <strong>
                    {entry.kind} · {entry.reasonCode}
                  </strong>
                  <small>
                    {entry.dimension} · ({entry.x.toFixed(1)}, {entry.y.toFixed(1)},{" "}
                    {entry.z.toFixed(1)}) · 半径 {entry.radius.toFixed(1)} ·{" "}
                    {entry.expiresAt === null
                      ? "永久"
                      : `${new Date(entry.expiresAt).toLocaleTimeString()} 过期`}
                  </small>
                  {entry.reasonDetail ? <small>{entry.reasonDetail}</small> : null}
                </div>
                <button
                  type="button"
                  className="action action--ghost"
                  disabled={disabled}
                  onClick={() => onForgetRouteBlacklist(entry.id)}
                >
                  删除
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="versions-title">
        <h3 id="versions-title">人格版本 · {versions.length}</h3>
        {versions.length === 0 ? (
          <p className="panel-note">暂无历史版本。</p>
        ) : (
          <ul className="ops-list">
            {versions.map((version) => (
              <li key={version.id} className="ops-item" data-active={version.state === "active"}>
                <div>
                  <strong>
                    v{version.revision} {version.state === "active" ? "· 生效中" : ""}
                  </strong>
                  <small>{summarize(version.content, active)}</small>
                </div>
                <button
                  type="button"
                  className="action action--ghost"
                  disabled={disabled || version.state === "active"}
                  onClick={() => onActivate(version.id)}
                >
                  回滚
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

const WORLD_KIND_LABELS: Record<string, string> = {
  home: "家",
  mine: "矿洞",
  resource: "资源",
  hazard: "危险",
  container: "箱子",
  bed: "床",
  furnace: "熔炉",
  crafting_table: "工作台",
  portal: "传送门",
};

function WorldMemoryView({
  memories,
  disabled,
  onUpdate,
  onForget,
}: {
  readonly memories: NonNullable<OpsSnapshot["worldMemories"]>;
  readonly disabled: boolean;
  readonly onUpdate: (memory: import("@craftmate/contracts").WorldMemoryUpdate) => void;
  readonly onForget: (memoryId: string) => void;
}): React.JSX.Element {
  const [drafts, setDrafts] = useState<Record<string, { label: string; x: string; y: string; z: string }>>({});
  return (
    <section aria-labelledby="world-memory-title">
      <h3 id="world-memory-title">世界记忆 · {memories.length}</h3>
      {memories.length === 0 ? (
        <p className="panel-note">还没有记录地点。身体放置床、箱子或发现矿洞后会自动写入。</p>
      ) : (
        <ul className="ops-list">
          {memories.slice(0, 30).map((memory) => {
            const draft = drafts[memory.id] ?? {
              label: memory.label,
              x: String(memory.x),
              y: String(memory.y),
              z: String(memory.z),
            };
            return (
              <li key={memory.id} className="ops-item">
                <div>
                  <strong>
                    {WORLD_KIND_LABELS[memory.kind] ?? memory.kind} · {memory.label}
                  </strong>
                  <small>
                    {memory.dimension} · 置信度 {memory.confidence.toFixed(2)} · {memory.source}
                  </small>
                  <div className="inline-pair">
                    <input
                      className="input input--short"
                      aria-label="记忆名称"
                      value={draft.label}
                      onChange={(event) =>
                        setDrafts((current) => ({
                          ...current,
                          [memory.id]: { ...draft, label: event.target.value },
                        }))
                      }
                    />
                    {(["x", "y", "z"] as const).map((axis) => (
                      <input
                        key={axis}
                        className="input input--short"
                        aria-label={axis}
                        type="number"
                        value={draft[axis]}
                        onChange={(event) =>
                          setDrafts((current) => ({
                            ...current,
                            [memory.id]: { ...draft, [axis]: event.target.value },
                          }))
                        }
                      />
                    ))}
                  </div>
                </div>
                <div className="inline-pair">
                  <button
                    type="button"
                    className="action action--ghost"
                    disabled={disabled}
                    onClick={() =>
                      onUpdate({
                        id: memory.id,
                        label: draft.label.trim() || memory.label,
                        x: Number(draft.x),
                        y: Number(draft.y),
                        z: Number(draft.z),
                      })
                    }
                  >
                    改正
                  </button>
                  <button
                    type="button"
                    className="action action--ghost"
                    disabled={disabled}
                    onClick={() => onForget(memory.id)}
                  >
                    删除
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function summarize(
  content: Record<string, unknown>,
  active: ShowSettings["persona"] | undefined,
): string {
  const weights = content.weights as Record<string, number> | undefined;
  const tone = typeof content.tone === "string" ? content.tone : null;
  const parts: string[] = [];
  if (tone) parts.push(`语气 ${tone}`);
  if (weights) {
    const changed = WEIGHT_LABELS.filter(
      ([key]) => active !== undefined && Math.abs((active.weights[key] ?? 0) - (weights[key] ?? 0)) > 0.001,
    ).map(([key, label]) => `${label} ${(weights[key] ?? 0).toFixed(2)}`);
    parts.push(changed.length > 0 ? `差异：${changed.join(" · ")}` : "权重与当前一致");
  }
  return parts.join(" · ") || "（无摘要）";
}
