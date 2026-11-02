import type { OperatorKind, ShowMode, ShowSnapshot } from "@craftmate/contracts";
import { DecisionStream } from "../DecisionStream.tsx";
import { OperatorBar } from "../OperatorBar.tsx";
import type { WireState } from "../../lib/connection.ts";

export type DrawerMode = "decisions" | "persona" | "connections";

interface OperationsDrawerProps {
  readonly mode: DrawerMode;
  readonly state: WireState;
  readonly showMode: ShowMode;
  readonly personaName: string;
  readonly snapshot: ShowSnapshot;
  readonly onClose: () => void;
  readonly onComment: (nickname: string, text: string) => void;
  readonly onOperator: (kind: OperatorKind, text?: string) => void;
  readonly onBurst: () => void;
}

const TITLES: Record<DrawerMode, { readonly title: string; readonly detail: string }> = {
  decisions: { title: "评论与决策", detail: "每条弹幕为什么被执行、排队或拒绝" },
  persona: { title: "角色与人格", detail: "当前以单一人格运行，可在这里查看设定" },
  connections: { title: "接入与语音", detail: "抖音评论、模型与语音的连接状态" },
};

export function OperationsDrawer({
  mode,
  state,
  showMode,
  personaName,
  snapshot,
  onClose,
  onComment,
  onOperator,
  onBurst,
}: OperationsDrawerProps): React.JSX.Element {
  const title = TITLES[mode];

  return (
    <div className="drawer-layer">
      <button className="drawer-scrim" type="button" aria-label="关闭操作面板" onClick={onClose} />
      <section className="drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title">
        <header className="drawer__head">
          <div>
            <h2 id="drawer-title">{title.title}</h2>
            <p>{title.detail}</p>
          </div>
          <button className="drawer__close" type="button" aria-label="关闭" onClick={onClose}>
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="m5 5 10 10M15 5 5 15" />
            </svg>
          </button>
        </header>

        <div className="drawer__body">
          {mode === "decisions" ? <DecisionsView snapshot={snapshot} /> : null}
          {mode === "persona" ? <PersonaView personaName={personaName} /> : null}
          {mode === "connections" ? <ConnectionsView state={state} mode={showMode} /> : null}
        </div>

        {mode === "decisions" ? (
          <OperatorBar
            onComment={onComment}
            onOperator={onOperator}
            onBurst={onBurst}
            disabled={state !== "open"}
          />
        ) : null}
      </section>
    </div>
  );
}

function DecisionsView({ snapshot }: { readonly snapshot: ShowSnapshot }): React.JSX.Element {
  return (
    <div className="drawer__decisions">
      {snapshot.operatorNotice ? (
        <p className="panel-note" role="status">
          {snapshot.operatorNotice.detail}
          {snapshot.operatorNotice.text ? `：${snapshot.operatorNotice.text}` : ""}
        </p>
      ) : null}
      <dl className="decision-summary">
        <div><dt>收到</dt><dd>{snapshot.stats.received}</dd></div>
        <div><dt>执行</dt><dd>{snapshot.stats.executed}</dd></div>
        <div><dt>拒绝</dt><dd>{snapshot.stats.refused}</dd></div>
      </dl>
      <DecisionStream decisions={snapshot.decisions} />
    </div>
  );
}

function PersonaView({ personaName }: { readonly personaName: string }): React.JSX.Element {
  return (
    <div className="persona-view">
      <div className="persona-view__portrait" aria-hidden="true">
        <span>鱼</span>
      </div>
      <div>
        <span className="eyebrow">当前人格</span>
        <h3>{personaName}</h3>
        <p>软萌爱撒娇的蓝色鲸鱼娘，贪吃爱面子，大方承认自己是「大肥鱼」。</p>
      </div>
      <dl className="persona-view__facts">
        <div><dt>语气</dt><dd>软糯、短句、会撒娇</dd></div>
        <div><dt>坚持</dt><dd>不吹牛，答应的事尽量做到</dd></div>
        <div><dt>偏好</dt><dd>白饭和钻石一样重要</dd></div>
        <div><dt>边界</dt><dd>危险动作会认真拒绝</dd></div>
      </dl>
      <p className="panel-note">人格编辑与试听将在接入 DeepSeek 和火山 TTS 后开放。</p>
    </div>
  );
}

function ConnectionsView({ state, mode }: { readonly state: WireState; readonly mode: ShowMode }): React.JSX.Element {
  return (
    <div className="connections-view">
      <ConnectionRow label="本地执行内核" value={state === "open" ? "已连接" : "未连接"} tone={state === "open" ? "good" : "bad"} />
      <ConnectionRow label="运行模式" value={modeLabel(mode)} tone={mode === "agent" ? "good" : "warn"} />
      <ConnectionRow label="Fabric Bridge" value="等待接入" tone="quiet" />
      <ConnectionRow label="抖音直播" value="待配置" tone="quiet" />
      <ConnectionRow label="DeepSeek" value="待配置 API Key" tone="quiet" />
      <ConnectionRow label="语音合成" value="待配置音色" tone="quiet" />
      <p className="panel-note">这些是下一阶段的接入点，没有连接时界面会明确显示，不会假装在线。</p>
    </div>
  );
}

interface ConnectionRowProps {
  readonly label: string;
  readonly value: string;
  readonly tone: "good" | "warn" | "bad" | "quiet";
}

function ConnectionRow({ label, value, tone }: ConnectionRowProps): React.JSX.Element {
  return (
    <div className="connection-row">
      <span className="connection-row__dot" data-tone={tone} aria-hidden="true" />
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function modeLabel(mode: ShowMode): string {
  if (mode === "operator") return "操作员接管";
  if (mode === "stopped") return "已急停";
  return "Agent 自主";
}
