import type {
  OperatorKind,
  ShowMode,
  ShowSettings,
  ShowSnapshot,
  VoiceStatus,
  VoiceSubtitle,
} from "@craftmate/contracts";
import { useState } from "react";
import { DecisionStream } from "../DecisionStream.tsx";
import { OperatorBar } from "../OperatorBar.tsx";
import { SettingsView } from "../settings/SettingsView.tsx";
import type { WireState } from "../../lib/connection.ts";
import type { Preferences } from "../../lib/preferences.ts";

export type DrawerMode = "decisions" | "persona" | "connections" | "settings";

interface OperationsDrawerProps {
  readonly mode: DrawerMode;
  readonly state: WireState;
  readonly showMode: ShowMode;
  readonly personaName: string;
  readonly snapshot: ShowSnapshot;
  readonly lastError: string | null;
  readonly subtitles: readonly VoiceSubtitle[];
  readonly settings: ShowSettings | null;
  readonly preferences: Preferences;
  readonly onClose: () => void;
  readonly onComment: (nickname: string, text: string) => void;
  readonly onOperator: (kind: OperatorKind, text?: string) => void;
  readonly onBurst: () => void;
  readonly onSpeak: (text: string) => void;
  readonly onSaveSettings: (next: ShowSettings) => void;
  readonly onPreferences: (patch: Partial<Preferences>) => void;
  readonly onResetPreferences: () => void;
}

const TITLES: Record<DrawerMode, { readonly title: string; readonly detail: string }> = {
  decisions: { title: "评论与决策", detail: "每条弹幕为什么被执行、排队或拒绝" },
  persona: { title: "角色与人格", detail: "当前以单一人格运行，可在这里查看设定" },
  connections: { title: "接入与语音", detail: "抖音评论、模型与语音的连接状态" },
  settings: { title: "设置", detail: "直播资料、人格权重与界面偏好" },
};

export function OperationsDrawer({
  mode,
  state,
  showMode,
  personaName,
  snapshot,
  lastError,
  subtitles,
  settings,
  preferences,
  onClose,
  onComment,
  onOperator,
  onBurst,
  onSpeak,
  onSaveSettings,
  onPreferences,
  onResetPreferences,
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
          {mode === "persona" ? (
            <PersonaView personaName={personaName} settings={settings} />
          ) : null}
          {mode === "connections" ? (
            <ConnectionsView
              state={state}
              mode={showMode}
              settings={settings}
              snapshot={snapshot}
              lastError={lastError}
              subtitles={subtitles}
              onSpeak={onSpeak}
            />
          ) : null}
          {mode === "settings" ? (
            <SettingsView
              settings={settings}
              state={state}
              preferences={preferences}
              onPreferences={onPreferences}
              onResetPreferences={onResetPreferences}
              onSave={onSaveSettings}
            />
          ) : null}
        </div>

        {mode === "decisions" ? (
          <OperatorBar
            personaName={personaName}
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

function PersonaView({
  personaName,
  settings,
}: {
  readonly personaName: string;
  readonly settings: ShowSettings | null;
}): React.JSX.Element {
  const persona = settings?.persona;

  return (
    <div className="persona-view">
      <div className="persona-view__portrait" aria-hidden="true">
        <span>鱼</span>
      </div>
      <div>
        <span className="eyebrow">当前人格</span>
        <h3>{personaName}</h3>
        <p>{persona?.identity ?? "正在读取人格设定…"}</p>
      </div>
      <dl className="persona-view__facts">
        <div><dt>语气</dt><dd>{persona?.tone ?? "—"}</dd></div>
        <div><dt>坚持</dt><dd>{persona?.values.join(" · ") || "—"}</dd></div>
        <div><dt>边界</dt><dd>{persona?.boundaries.join(" · ") || "—"}</dd></div>
        <div><dt>音色</dt><dd>{persona ? `${persona.voice.voiceId} @ ${persona.voice.speed}×` : "—"}</dd></div>
      </dl>
      <div className="weight-bars">
        {persona
          ? (
              [
                ["obedience", "听话"],
                ["risk", "冒险"],
                ["sass", "嘴硬"],
                ["patience", "耐心"],
                ["gluttony", "贪吃"],
              ] as const
            ).map(([key, label]) => (
              <div key={key} className="weight-bar">
                <span>{label}</span>
                <i><b style={{ width: `${persona.weights[key] * 100}%` }} /></i>
                <em>{persona.weights[key].toFixed(2)}</em>
              </div>
            ))
          : null}
      </div>
      <p className="panel-note">人格修改在「设置」里保存后立即影响仲裁；试听要等 TTS 接入。</p>
    </div>
  );
}

function ConnectionsView({
  state,
  mode,
  settings,
  snapshot,
  lastError,
  subtitles,
  onSpeak,
}: {
  readonly state: WireState;
  readonly mode: ShowMode;
  readonly settings: ShowSettings | null;
  readonly snapshot: ShowSnapshot;
  readonly lastError: string | null;
  readonly subtitles: readonly VoiceSubtitle[];
  readonly onSpeak: (text: string) => void;
}): React.JSX.Element {
  const room = settings?.integrations.douyinRoomId;
  const model = settings?.integrations.deepseekModel;
  const source = snapshot.sourceHealth;
  const voice = snapshot.voiceStatus;

  return (
    <div className="connections-view">
      {lastError ? (
        <p className="connection-error" role="alert">
          服务端错误：{lastError}
        </p>
      ) : null}
      <ConnectionRow label="本地执行内核" value={state === "open" ? "已连接" : "未连接"} tone={state === "open" ? "good" : "bad"} />
      <ConnectionRow label="运行模式" value={modeLabel(mode)} tone={mode === "agent" ? "good" : "warn"} />
      <ConnectionRow label="Fabric Bridge" value="等待接入" tone="quiet" />
      <ConnectionRow
        label="抖音直播"
        value={source ? `${source.detail}${room ? ` · 房间 ${room}` : ""}` : room ? `房间 ${room}（未联调）` : "待配置"}
        tone={sourceTone(source?.state)}
      />
      <ConnectionRow label="模型" value={model ? `${model}（未接 Key）` : "待配置 API Key"} tone="quiet" />
      <ConnectionRow
        label="语音合成"
        value={voiceLabel(voice, settings)}
        tone={voiceTone(voice)}
      />
      {voice ? (
        <dl className="decision-summary">
          <div><dt>已说</dt><dd>{voice.spoken}</dd></div>
          <div><dt>失败</dt><dd>{voice.failed}</dd></div>
          <div><dt>排队</dt><dd>{voice.queued}</dd></div>
        </dl>
      ) : null}
      <VoicePreview disabled={state !== "open"} onSpeak={onSpeak} />
      {subtitles.length > 0 ? (
        <section className="subtitle-log" aria-label="最近字幕">
          <h3>字幕</h3>
          {subtitles.slice(0, 5).map((subtitle) => (
            <p key={`${subtitle.id}-${subtitle.state}`} data-state={subtitle.state}>
              <span>{subtitle.state === "spoken" ? "已播" : subtitle.state === "speaking" ? "正在说" : "未播出"}</span>
              {subtitle.text}
            </p>
          ))}
        </section>
      ) : null}
      <p className="panel-note">
        语音状态来自独立 Voice 服务；没有连接时界面会明确显示，不会假装在线。
      </p>
    </div>
  );
}

function VoicePreview({
  disabled,
  onSpeak,
}: {
  readonly disabled: boolean;
  readonly onSpeak: (text: string) => void;
}): React.JSX.Element {
  const [text, setText] = useState("唔，我是大肥鱼，今天也要好好吃饭。");

  return (
    <form
      className="voice-preview"
      onSubmit={(event) => {
        event.preventDefault();
        onSpeak(text);
      }}
    >
      <input
        className="input"
        value={text}
        maxLength={200}
        aria-label="试听文本"
        onChange={(event) => setText(event.target.value)}
      />
      <button type="submit" className="action" disabled={disabled || text.trim().length === 0}>
        试听
      </button>
    </form>
  );
}

function sourceTone(state: string | undefined): "good" | "warn" | "bad" | "quiet" {
  if (state === "open") return "good";
  if (state === "connecting") return "warn";
  if (state === "error" || state === "closed") return "bad";
  return "quiet";
}

function voiceLabel(status: VoiceStatus | null, settings: ShowSettings | null): string {
  if (!status) {
    return settings ? `${settings.persona.voice.provider} / ${settings.persona.voice.voiceId}（未连接）` : "待配置音色";
  }
  if (status.state === "speaking") return `正在说话 · 队列 ${status.queued}`;
  if (status.state === "degraded") return `仅字幕 · ${status.detail}`;
  if (status.state === "disabled") return "已停用";
  return `待命 · 已说 ${status.spoken}`;
}

function voiceTone(status: VoiceStatus | null): "good" | "warn" | "bad" | "quiet" {
  if (!status) return "quiet";
  if (status.state === "idle") return "good";
  if (status.state === "speaking") return "warn";
  return "bad";
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
