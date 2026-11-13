import type {
  IntegrationSettingsUpdate,
  IntegrationSettingsView,
  ModelCatalog,
  OpsSnapshot,
  ShowMode,
  ShowSettings,
  ShowSnapshot,
  VoiceStatus,
  TimelineEntry,
  VoiceSubtitle,
  WorldMemoryUpdate,
} from "@craftmate/contracts";
import { useState } from "react";
import { SettingsView } from "../settings/SettingsView.tsx";
import { OpsView } from "../ops/OpsView.tsx";
import { ReplayView } from "../ops/ReplayView.tsx";
import type { WireState } from "../../lib/connection.ts";
import type { Preferences } from "../../lib/preferences.ts";
import { clock } from "../../lib/format.ts";
import mascot from "../../assets/dafeiyu.png";

export type WorkspaceView =
  | "persona"
  | "connections"
  | "settings"
  | "memory"
  | "replay";

interface OperationsPageProps {
  readonly mode: WorkspaceView;
  readonly state: WireState;
  readonly showMode: ShowMode;
  readonly personaName: string;
  readonly snapshot: ShowSnapshot;
  readonly lastError: string | null;
  readonly subtitles: readonly VoiceSubtitle[];
  readonly settings: ShowSettings | null;
  readonly integrations: IntegrationSettingsView | null;
  readonly integrationRevision: number;
  readonly modelCatalog: ModelCatalog | null;
  readonly modelCatalogPending: boolean;
  readonly preferences: Preferences;
  readonly onSpeak: (text: string) => void;
  readonly onSaveSettings: (next: ShowSettings) => void;
  readonly onSaveIntegrationSettings: (
    settings: ShowSettings,
    integrations: IntegrationSettingsUpdate,
  ) => void;
  readonly onFetchModels: (baseUrl: string, apiKey: string) => void;
  readonly onPreferences: (patch: Partial<Preferences>) => void;
  readonly onResetPreferences: () => void;
  readonly ops: OpsSnapshot | null;
  readonly timeline: readonly TimelineEntry[];
  readonly timelinePending: boolean;
  readonly onApproveMemory: (candidateId: string) => void;
  readonly onRejectMemory: (candidateId: string, reason: string) => void;
  readonly onForgetMemory: (memoryId: string) => void;
  readonly onUpdateWorldMemory: (memory: WorldMemoryUpdate) => void;
  readonly onForgetWorldMemory: (memoryId: string) => void;
  readonly onForgetStrategyMemory: (memoryId: string) => void;
  readonly onForgetRouteBlacklist: (blacklistId: string) => void;
  readonly onActivatePersona: (versionId: string) => void;
  readonly onLookupTrace: (traceId: string) => void;
  readonly onSetGoal: (title: string, description: string) => void;
  readonly onPauseGoal: () => void;
  readonly onResumeGoal: () => void;
}

const TITLES: Record<WorkspaceView, string> = {
  persona: "角色与人格",
  connections: "接入与语音",
  settings: "设置",
  memory: "记忆与版本",
  replay: "回放",
};

export function OperationsPage({
  mode,
  state,
  showMode,
  personaName,
  snapshot,
  lastError,
  subtitles,
  settings,
  integrations,
  integrationRevision,
  modelCatalog,
  modelCatalogPending,
  preferences,
  onSpeak,
  onSaveSettings,
  onSaveIntegrationSettings,
  onFetchModels,
  onPreferences,
  onResetPreferences,
  ops,
  timeline,
  timelinePending,
  onApproveMemory,
  onRejectMemory,
  onForgetMemory,
  onUpdateWorldMemory,
  onForgetWorldMemory,
  onForgetStrategyMemory,
  onForgetRouteBlacklist,
  onActivatePersona,
  onLookupTrace,
  onSetGoal,
  onPauseGoal,
  onResumeGoal,
}: OperationsPageProps): React.JSX.Element {
  const title = TITLES[mode];

  return (
    <main className="operations-page" aria-labelledby="operations-title">
        <header className="drawer__head">
          <h1 id="operations-title">{title}</h1>
          <span className="drawer__status" data-state={state}>
            {state === "open" ? modeLabel(showMode) : state === "connecting" ? "连接中" : "离线"}
          </span>
        </header>

        <div className="drawer__body">
          {mode === "persona" ? (
            <PersonaView personaName={personaName} settings={settings} />
          ) : null}
          {mode === "connections" ? (
            <ConnectionsView
              state={state}
              mode={showMode}
              settings={settings}
              integrations={integrations}
              snapshot={snapshot}
              lastError={lastError}
              subtitles={subtitles}
              onSpeak={onSpeak}
            />
          ) : null}
          {mode === "memory" ? (
            <OpsView
              ops={ops}
              settings={settings}
              disabled={state !== "open"}
              onApprove={onApproveMemory}
              onReject={onRejectMemory}
              onForget={onForgetMemory}
              onUpdateWorldMemory={onUpdateWorldMemory}
              onForgetWorldMemory={onForgetWorldMemory}
              onForgetStrategyMemory={onForgetStrategyMemory}
              onForgetRouteBlacklist={onForgetRouteBlacklist}
              onActivate={onActivatePersona}
            />
          ) : null}
          {mode === "replay" ? (
            <ReplayView entries={timeline} pending={timelinePending} onLookup={onLookupTrace} />
          ) : null}
          {mode === "settings" ? (
            <SettingsView
              settings={settings}
              state={state}
              preferences={preferences}
              onPreferences={onPreferences}
              onResetPreferences={onResetPreferences}
              onSave={onSaveSettings}
              integrations={integrations}
              integrationRevision={integrationRevision}
              modelCatalog={modelCatalog}
              modelCatalogPending={modelCatalogPending}
              lastError={lastError}
              model={snapshot.model}
              onSaveIntegrations={onSaveIntegrationSettings}
              onFetchModels={onFetchModels}
              goal={snapshot.goal}
              onSetGoal={onSetGoal}
              onPauseGoal={onPauseGoal}
              onResumeGoal={onResumeGoal}
            />
          ) : null}
        </div>

    </main>
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
      <div className="persona-view__intro">
        <div className="persona-view__portrait" aria-hidden="true">
          <img src={mascot} alt="" />
        </div>
        <div>
          <h3>{personaName}</h3>
          <p>{persona?.identity ?? "正在读取人格设定…"}</p>
        </div>
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
    </div>
  );
}

function ConnectionsView({
  state,
  mode,
  settings,
  integrations,
  snapshot,
  lastError,
  subtitles,
  onSpeak,
}: {
  readonly state: WireState;
  readonly mode: ShowMode;
  readonly settings: ShowSettings | null;
  readonly integrations: IntegrationSettingsView | null;
  readonly snapshot: ShowSnapshot;
  readonly lastError: string | null;
  readonly subtitles: readonly VoiceSubtitle[];
  readonly onSpeak: (text: string) => void;
}): React.JSX.Element {
  const room = settings?.integrations.douyinRoomId;
  const model = integrations?.model;
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
      <ConnectionRow
        label="Fabric Bridge"
        value={bridgeLabel(snapshot)}
        tone={snapshot.bridge?.connected ? "good" : "quiet"}
      />
      <ConnectionRow
        label="游戏世界"
        value={worldLabel(snapshot)}
        tone={
          snapshot.bridge?.world?.inWorld
            ? "good"
            : snapshot.bridge?.connected
              ? "warn"
              : "quiet"
        }
      />
      {snapshot.bridge?.world?.inWorld ? (
        <dl className="decision-summary">
          <div><dt>生命</dt><dd>{formatStat(snapshot.bridge.world.health)}</dd></div>
          <div><dt>饥饿</dt><dd>{formatStat(snapshot.bridge.world.food)}</dd></div>
          <div><dt>快捷栏</dt><dd>{snapshot.bridge.world.hotbar?.length ?? 0}</dd></div>
        </dl>
      ) : null}
      <ReflexLog incidents={snapshot.bridge?.incidents ?? []} />
      <ConnectionRow
        label="抖音直播"
        value={source ? `${source.detail}${room ? ` · 房间 ${room}` : ""}` : room ? `房间 ${room}（等待 Ingress）` : "待配置"}
        tone={sourceTone(source?.state)}
      />
      <ConnectionRow
        label="模型"
        value={snapshot.model?.state === "ready"
          ? `${snapshot.model.provider} / ${snapshot.model.model} · 正常`
          : snapshot.model?.state === "error"
            ? `${snapshot.model.provider} / ${snapshot.model.model} · 最近请求失败`
            : snapshot.model?.state === "unverified"
              ? `${snapshot.model.provider} / ${snapshot.model.model} · 已配置，等待请求`
              : model?.model
                ? `${model.model}（未配置 API Key）`
                : "待配置模型"}
        tone={snapshot.model?.state === "ready"
          ? "good"
          : snapshot.model?.state === "error"
            ? "bad"
            : snapshot.model?.state === "unverified"
              ? "warn"
              : "quiet"}
      />
      {snapshot.model?.state === "error" && snapshot.model.detail
        ? <p className="connection-error" role="status">模型错误：{snapshot.model.detail}</p>
        : null}
      <ConnectionRow
        label="语音合成"
        value={voiceLabel(voice, integrations, settings)}
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
        <section className="subtitle-log" aria-label="最近语音">
          {subtitles.slice(0, 5).map((subtitle) => (
            <p key={`${subtitle.id}-${subtitle.state}`} data-state={subtitle.state}>
              <span>{subtitle.state === "spoken" ? "已播" : subtitle.state === "speaking" ? "正在说" : "未播出"}</span>
              {`#${subtitle.id.slice(-6)}`}
              {subtitle.state === "failed" && subtitle.detail ? (
                <small>播放器错误：{subtitle.detail}</small>
              ) : null}
            </p>
          ))}
        </section>
      ) : null}
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

function bridgeLabel(snapshot: ShowSnapshot): string {
  const bridge = snapshot.bridge;
  if (!bridge) return "等待接入";
  if (!bridge.connected) return "未连接任何身体";
  return `${bridge.client ?? "未知身体"} · ${bridge.owner} · 队列 ${bridge.queued}`;
}

function worldLabel(snapshot: ShowSnapshot): string {
  const bridge = snapshot.bridge;
  if (!bridge?.connected) return "游戏客户端未连接";
  const world = bridge.world;
  if (!world?.inWorld) return "客户端已连接，等待进入世界";
  const dimension =
    world.world === "minecraft:overworld"
      ? "主世界"
      : world.world === "minecraft:the_nether"
        ? "下界"
        : world.world === "minecraft:the_end"
          ? "末地"
          : world.world ?? "未知维度";
  const position = world.position
    ? ` · ${Math.round(world.position.x)}, ${Math.round(world.position.y)}, ${Math.round(world.position.z)}`
    : "";
  const item = world.selectedItem ? ` · ${world.selectedItem}` : "";
  return `${dimension}${position}${item}`;
}

function formatStat(value: number | null | undefined): string {
  if (value == null) return "—";
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

const INCIDENT_LABELS: Record<string, string> = {
  lava: "岩浆",
  low_health: "低血",
  falling: "坠落",
  drowning: "溺水",
  on_fire: "着火",
  starving: "饥饿",
  creeper: "苦力怕",
  retreat: "撤退",
  blocked: "受阻",
};

/**
 * Reflexes are the moments that changed the plan without a comment asking
 * for it. Showing them next to health makes "why did it stop mining" answerable
 * without replaying the decision stream.
 */
function ReflexLog({
  incidents,
}: {
  readonly incidents: NonNullable<ShowSnapshot["bridge"]>["incidents"];
}): React.JSX.Element | null {
  if (incidents.length === 0) return null;
  const recent = incidents.slice(-4);
  return (
    <section aria-labelledby="reflex-title">
      <h3 id="reflex-title">身体避险</h3>
      <ul className="ops-list">
        {recent.map((incident, index) => (
          <li key={`${incident.at}-${index}`} className="ops-item">
            <div>
              <strong>{INCIDENT_LABELS[incident.kind] ?? incident.kind}</strong>
              <small>{incident.detail}</small>
            </div>
            <time dateTime={new Date(incident.at).toISOString()}>
              {new Date(incident.at).toLocaleTimeString("zh-CN", { hour12: false })}
            </time>
          </li>
        ))}
      </ul>
    </section>
  );
}

function sourceTone(state: string | undefined): "good" | "warn" | "bad" | "quiet" {
  if (state === "open") return "good";
  if (state === "connecting") return "warn";
  if (state === "error" || state === "closed") return "bad";
  return "quiet";
}

function voiceLabel(
  status: VoiceStatus | null,
  integrations: IntegrationSettingsView | null,
  settings: ShowSettings | null,
): string {
  if (!status) {
    return integrations?.voice.voiceId
      ? `${integrations.voice.voiceId}（Voice 未连接）`
      : settings
        ? `${settings.persona.voice.voiceId}（未连接）`
        : "待配置音色";
  }
  if (status.state === "speaking") return `正在说话 · 队列 ${status.queued}`;
  if (status.state === "degraded") return `语音异常 · ${status.detail}`;
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
      <span>{label}</span>
      <strong data-tone={tone}>{value}</strong>
    </div>
  );
}

function modeLabel(mode: ShowMode): string {
  if (mode === "operator") return "操作员接管";
  if (mode === "stopped") return "已急停";
  return "Agent 自主";
}
