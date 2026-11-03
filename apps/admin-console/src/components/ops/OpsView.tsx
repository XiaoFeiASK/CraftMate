import type { ShowSettings } from "@craftmate/contracts";
import type { OpsSnapshot } from "@craftmate/contracts";
import { MemoryView } from "./MemoryView.tsx";

interface OpsViewProps {
  readonly ops: OpsSnapshot | null;
  readonly settings: ShowSettings | null;
  readonly disabled: boolean;
  readonly onApprove: (candidateId: string) => void;
  readonly onReject: (candidateId: string, reason: string) => void;
  readonly onForget: (memoryId: string) => void;
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
  onActivate,
}: OpsViewProps): React.JSX.Element {
  if (!ops) {
    return <p className="panel-note">正在读取运营数据…</p>;
  }

  const active = settings?.persona;
  const versions = ops.personaVersions;

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

      <section aria-labelledby="versions-title">
        <h3 id="versions-title">人格版本 · {versions.length}</h3>
        {versions.length === 0 ? (
          <p className="panel-note">还没有历史版本。保存一次人格修改后会生成新版本。</p>
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
