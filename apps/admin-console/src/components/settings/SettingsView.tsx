import { useEffect, useId, useMemo, useRef, useState, cloneElement, isValidElement, type FormEvent, type ReactNode } from "react";
import {
  integrationSettingsUpdateSchema,
  showSettingsSchema,
  type IntegrationSettingsUpdate,
  type IntegrationSettingsView,
  type GoalProgress,
  type GoalStrategy,
  type ModelCatalog,
  type ShowSnapshot,
  type PersonaProfile,
  type ShowSettings,
  MODEL_PROVIDER_PRESETS,
  modelProviderPresetFor,
  SEASON_GOAL_PRESETS,
} from "@craftmate/contracts";
import type { WireState } from "../../lib/connection.ts";
import type { Accent, Preferences, TextScale, ThemeMode } from "../../lib/preferences.ts";

interface SettingsViewProps {
  readonly settings: ShowSettings | null;
  readonly integrations: IntegrationSettingsView | null;
  readonly modelCatalog: ModelCatalog | null;
  readonly modelCatalogPending: boolean;
  readonly state: WireState;
  readonly integrationRevision: number;
  readonly lastError: string | null;
  readonly model: ShowSnapshot["model"];
  readonly preferences: Preferences;
  readonly onPreferences: (patch: Partial<Preferences>) => void;
  readonly onResetPreferences: () => void;
  readonly onSave: (next: ShowSettings) => void;
  readonly onSaveIntegrations: (
    settings: ShowSettings,
    integrations: IntegrationSettingsUpdate,
  ) => void;
  readonly onFetchModels: (baseUrl: string, apiKey: string) => void;
  readonly goal: GoalProgress | null;
  readonly onSetGoal: (title: string, description: string) => void;
  readonly onPauseGoal: () => void;
  readonly onResumeGoal: () => void;
}

const VALUE_LABEL = "每行一条，最多 8 条";
const CUSTOM_PROVIDER = "__custom__";

const STRATEGY_FIELDS: readonly {
  readonly key: keyof GoalStrategy;
  readonly label: string;
  readonly hint: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
}[] = [
  { key: "eatBelow", label: "进食阈值", hint: "饥饿值 ≤ 该值时进食", min: 1, max: 20, step: 1 },
  { key: "foodReserve", label: "食物储备", hint: "长期运行希望保留的食物数量", min: 0, max: 16, step: 1 },
  { key: "retreatHealth", label: "撤退血量", hint: "生命值 ≤ 该值立即撤退", min: 1, max: 20, step: 1 },
  { key: "engageHealth", label: "主动交战血量", hint: "低于该值不主动交战", min: 1, max: 20, step: 1 },
  { key: "miningFood", label: "下矿食物", hint: "下矿前至少携带的份数", min: 0, max: 16, step: 1 },
  { key: "miningEmptySlots", label: "下矿空格", hint: "背包至少保留的空格数", min: 0, max: 36, step: 1 },
  { key: "miningBlocks", label: "下矿方块", hint: "下矿前准备的垫脚/封路方块", min: 0, max: 128, step: 1 },
  { key: "nightReturnAt", label: "回家时间", hint: "游戏 tick；11000 后开始回营地", min: 0, max: 23999, step: 500 },
  { key: "sleepAt", label: "睡觉时间", hint: "游戏 tick；12000 后优先睡觉", min: 0, max: 23999, step: 500 },
  { key: "exploreRadius", label: "探索半径", hint: "格；主动探索的最大距离", min: 16, max: 512, step: 16 },
  { key: "cardMinDwellMs", label: "卡片最短驻留", hint: "毫秒；换卡的最短间隔", min: 0, max: 600000, step: 5000 },
];

export function SettingsView({
  settings,
  integrations,
  modelCatalog,
  modelCatalogPending,
  state,
  integrationRevision,
  lastError,
  model,
  preferences,
  onPreferences,
  onResetPreferences,
  onSave,
  onSaveIntegrations,
  onFetchModels,
  goal,
  onSetGoal,
  onPauseGoal,
  onResumeGoal,
}: SettingsViewProps): React.JSX.Element {
  const [draft, setDraft] = useState<ShowSettings | null>(settings);
  const [integrationDraft, setIntegrationDraft] = useState<IntegrationSettingsView | null>(
    integrations,
  );
  const [saved, setSaved] = useState<string | null>(null);
  const [secrets, setSecrets] = useState({ model: "", voice: "" });
  /** Raw textarea text so pressing Enter is not normalised away mid-edit. */
  const [listDrafts, setListDrafts] = useState<{ values: string; boundaries: string } | null>(null);
  const savedSnapshot = useRef<string>(settings ? JSON.stringify(settings) : "");
  const draftRef = useRef(draft);
  const pendingSave = useRef(false);
  const submittedRevision = useRef(integrationRevision);
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState("接入");

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  // Server pushes replace the draft only when there is nothing unsaved. A
  // background broadcast must not erase what the operator is typing.
  useEffect(() => {
    if (!settings) return;
    const incoming = JSON.stringify(settings);
    const current = draftRef.current;
    if (current === null || JSON.stringify(current) === savedSnapshot.current) {
      setDraft(settings);
      setListDrafts(null);
      savedSnapshot.current = incoming;
    }
  }, [settings]);

  useEffect(() => {
    if (!pendingSave.current) {
      if (integrations) setIntegrationDraft(integrations);
      return;
    }
    if (integrationRevision <= submittedRevision.current || !settings || !integrations) return;
    pendingSave.current = false;
    setSaving(false);
    setDraft(settings);
    setIntegrationDraft(integrations);
    savedSnapshot.current = JSON.stringify(settings);
    setSecrets({ model: "", voice: "" });
    setSaved("已保存并应用。模型连接状态见下方；凭据无需另存到 .env。");
  }, [integrationRevision, integrations, settings]);

  useEffect(() => {
    if (!saving) return;
    if (lastError || state !== "open") {
      pendingSave.current = false;
      setSaving(false);
      setSaved(lastError ? `保存失败：${lastError}` : "连接已断开，保存结果未确认，请重连后核对。");
    }
  }, [lastError, state, saving]);

  useEffect(() => {
    if (!saving) return;
    const timer = window.setTimeout(() => {
      pendingSave.current = false;
      setSaving(false);
      setSaved("未收到保存确认，请检查连接后重试。");
    }, 10_000);
    return () => window.clearTimeout(timer);
  }, [saving]);

  const validation = useMemo(
    () => (draft ? showSettingsSchema.safeParse(draft) : null),
    [draft],
  );
  const dirty = draft !== null && settings !== null && JSON.stringify(draft) !== JSON.stringify(settings);
  const integrationDirty =
    integrationDraft !== null &&
    integrations !== null &&
    JSON.stringify(integrationDraft) !== JSON.stringify(integrations);
  const providerPreset = integrationDraft
    ? modelProviderPresetFor(integrationDraft.model.provider, integrationDraft.model.baseUrl)
    : undefined;
  const modelTargetChanged =
    integrationDraft !== null &&
    integrations !== null &&
    (integrationDraft.model.provider !== integrations.model.provider ||
      normalizeBaseUrl(integrationDraft.model.baseUrl) !==
        normalizeBaseUrl(integrations.model.baseUrl));
  const catalogForEndpoint =
    modelCatalog !== null &&
    normalizeBaseUrl(modelCatalog.baseUrl) ===
      normalizeBaseUrl(integrationDraft?.model.baseUrl ?? "")
      ? modelCatalog
      : null;
  const modelUrlValid = isHttpUrl(integrationDraft?.model.baseUrl ?? "");
  const canFetchModels =
    modelUrlValid &&
    !modelCatalogPending &&
    state === "open" &&
    (!modelTargetChanged || secrets.model.trim().length > 0);
  const canSave =
    !saving && state === "open" &&
    (dirty || integrationDirty || secrets.model.length > 0 || secrets.voice.length > 0) &&
    validation?.success === true;

  if (!draft || !integrationDraft) {
    return (
      <div className="settings-view">
        <p className="panel-note">正在读取配置…</p>
      </div>
    );
  }

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (!canSave || !validation?.success) return;
    const integrationUpdate: IntegrationSettingsUpdate = {
      model: {
        provider: integrationDraft.model.provider,
        baseUrl: integrationDraft.model.baseUrl,
        model: integrationDraft.model.model,
        ...(secrets.model.trim() ? { apiKey: secrets.model.trim() } : {}),
        // A key belongs to its vendor. Never carry an old secret into a new
        // provider when the operator has not entered a replacement key.
        clearApiKey: modelTargetChanged && !secrets.model.trim(),
        timeoutMs: integrationDraft.model.timeoutMs,
      },
      voice: {
        provider: integrationDraft.voice.provider,
        url: integrationDraft.voice.url,
        voiceId: integrationDraft.voice.voiceId,
        ...(secrets.voice.trim() ? { apiKey: secrets.voice.trim() } : {}),
        clearApiKey: false,
        instructions: integrationDraft.voice.instructions,
        timeoutMs: integrationDraft.voice.timeoutMs,
      },
      douyin: integrationDraft.douyin,
    };
    const integrationValidation = integrationSettingsUpdateSchema.safeParse(integrationUpdate);
    if (!integrationValidation.success) {
      setSaved(`接入配置需要修正：${integrationValidation.error.issues[0]?.message ?? "格式错误"}`);
      return;
    }
    pendingSave.current = true;
    submittedRevision.current = integrationRevision;
    setSaving(true);
    onSaveIntegrations(
      {
        ...validation.data,
        integrations: {
          douyinRoomId: integrationValidation.data.douyin.roomId,
          deepseekModel: integrationValidation.data.model.model,
        },
        persona: {
          ...validation.data.persona,
          voice: {
            ...validation.data.persona.voice,
            provider: integrationValidation.data.voice.provider,
            voiceId: integrationValidation.data.voice.voiceId,
          },
        },
      },
      integrationValidation.data,
    );
    setSaved("正在保存并应用…");
  };

  const patch = (next: Partial<ShowSettings>): void => {
    setDraft((current) => (current ? { ...current, ...next } : current));
    setSaved(null);
  };

  const setIntegrationsDraft = (next: {
    model?: Partial<IntegrationSettingsView["model"]>;
    voice?: Partial<IntegrationSettingsView["voice"]>;
    douyin?: Partial<IntegrationSettingsView["douyin"]>;
  }): void => {
    setIntegrationDraft((current) =>
      current
        ? {
            model: { ...current.model, ...next.model },
            voice: { ...current.voice, ...next.voice },
            douyin: { ...current.douyin, ...next.douyin },
          }
        : current,
    );
    setSaved(null);
  };

  const listText = listDrafts ?? {
    values: draft.persona.values.join("\n"),
    boundaries: draft.persona.boundaries.join("\n"),
  };

  const patchPersona = (next: Partial<PersonaProfile>): void => {
    setDraft((current) =>
      current ? { ...current, persona: { ...current.persona, ...next } } : current,
    );
    setSaved(null);
  };

  const patchStrategy = (key: keyof GoalStrategy, value: number): void => {
    if (!Number.isFinite(value)) return;
    patch({
      goalStrategy: {
        ...draft.goalStrategy,
        [key]: Math.round(value),
      },
    });
  };

  const patchList = (field: "values" | "boundaries", text: string): void => {
    setListDrafts({ ...listText, [field]: text });
    patchPersona({ [field]: lines(text) });
  };

  return (
    <form className="settings-view" onSubmit={submit} data-tab={tab}>
      <div className="settings-tabs" role="tablist" aria-label="设置分类">
        {["接入", "直播资料", "目标模式", "角色与人格", "界面"].map((name) => (
          <button key={name} type="button" role="tab" aria-selected={tab === name}
            onClick={() => setTab(name)}>{name}</button>
        ))}
      </div>
      <fieldset className="settings-fields" disabled={saving}>
      <Section activeTab={tab} title="直播资料">
        <Field label="终极目标">
          <select
            className="input"
            value={draft.goal}
            onChange={(event) => {
              const preset = SEASON_GOAL_PRESETS.find((item) => item.title === event.target.value);
              patch({
                goal: event.target.value,
                goalDescription: preset?.description ?? "",
              });
            }}
          >
            {SEASON_GOAL_PRESETS.map((preset) => (
              <option key={preset.title} value={preset.title}>
                {preset.title}
              </option>
            ))}
            {SEASON_GOAL_PRESETS.some((preset) => preset.title === draft.goal) ? null : (
              <option value={draft.goal}>{draft.goal}</option>
            )}
          </select>
        </Field>
        {draft.goalDescription ? (
          <p className="settings-description">{draft.goalDescription}</p>
        ) : null}
        <Field label="世界名称">
          <input
            className="input"
            value={draft.worldName}
            maxLength={60}
            onChange={(event) => patch({ worldName: event.target.value })}
          />
        </Field>
        <Field label="游戏版本">
          <input
            className="input input--short"
            value={draft.gameVersion}
            maxLength={24}
            onChange={(event) => patch({ gameVersion: event.target.value })}
          />
        </Field>
        <Field label="账号说明">
          <input
            className="input"
            value={draft.accountLabel}
            maxLength={40}
            onChange={(event) => patch({ accountLabel: event.target.value })}
          />
        </Field>
      </Section>

      <Section activeTab={tab} title="目标模式">
        <Field label="目标模式">
          <button
            type="button"
            className="toggle"
            role="switch"
            aria-checked={draft.goalMode}
            data-on={draft.goalMode}
            onClick={() => patch({ goalMode: !draft.goalMode })}
          >
            <span />
          </button>
        </Field>
        <Field
          label="运行控制"
          hint={
            goal
              ? `${goal.stage.title} · ${goal.milestone.title} · ${goal.completed} 个里程碑已验证`
              : "尚未建立目标进度；未验证时不会显示百分比"
          }
        >
          <div className="inline-pair">
            <button
              type="button"
              className="action action--ghost"
              role="switch"
              aria-checked={draft.goalMode}
              data-on={draft.goalMode}
              disabled={state !== "open"}
              onClick={() => {
                if (draft.goalMode) {
                  onPauseGoal();
                } else {
                  patch({ goalMode: true });
                  onResumeGoal();
                }
              }}
            >
              {draft.goalMode ? "暂停" : "继续"}
            </button>
            <button
              type="button"
              className="action action--ghost"
              disabled={state !== "open" || draft.goal.trim().length === 0}
              onClick={() => onSetGoal(draft.goal.trim(), draft.goalDescription)}
            >
              立即应用目标
            </button>
          </div>
        </Field>
        <div className="settings-subhead">策略阈值</div>
        {STRATEGY_FIELDS.map((field) => (
          <Field key={field.key} label={field.label} hint={field.hint}>
            <input
              className="input input--short"
              type="number"
              min={field.min}
              max={field.max}
              step={field.step}
              value={draft.goalStrategy[field.key]}
              onChange={(event) => patchStrategy(field.key, Number(event.target.value))}
            />
          </Field>
        ))}
      </Section>

      <Section activeTab={tab} title="角色与人格">
        <Field label="角色名">
          <input
            className="input"
            value={draft.persona.name}
            maxLength={24}
            onChange={(event) => patchPersona({ name: event.target.value })}
          />
        </Field>
        <Field label="身份设定" align="stack">
          <textarea
            className="input input--area"
            value={draft.persona.identity}
            maxLength={280}
            rows={2}
            onChange={(event) => patchPersona({ identity: event.target.value })}
          />
        </Field>
        <Field label="语气">
          <input
            className="input"
            value={draft.persona.tone}
            maxLength={80}
            onChange={(event) => patchPersona({ tone: event.target.value })}
          />
        </Field>
        <Field label="价值观" hint={VALUE_LABEL} align="stack">
          <textarea
            className="input input--area"
            value={listText.values}
            rows={3}
            onChange={(event) => patchList("values", event.target.value)}
          />
        </Field>
        <Field label="边界" hint={VALUE_LABEL} align="stack">
          <textarea
            className="input input--area"
            value={listText.boundaries}
            rows={3}
            onChange={(event) => patchList("boundaries", event.target.value)}
          />
        </Field>
        <div className="weight-grid">
          {(
            [
              ["obedience", "听话"],
              ["risk", "冒险"],
              ["sass", "嘴硬"],
              ["patience", "耐心"],
              ["gluttony", "贪吃"],
            ] as const
          ).map(([key, label]) => (
            <label className="weight" key={key}>
              <span>
                {label}
                <output>{draft.persona.weights[key].toFixed(2)}</output>
              </span>
              <input
                className="slider"
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={draft.persona.weights[key]}
                onChange={(event) =>
                  patchPersona({
                    weights: { ...draft.persona.weights, [key]: Number(event.target.value) },
                  })
                }
              />
            </label>
          ))}
        </div>
      </Section>

      <Section activeTab={tab} title="接入">
        <div className="settings-connection" data-state={model?.state ?? "disabled"} role="status">
          <strong>{model?.state === "ready"
            ? "模型最近调用成功"
            : model?.state === "error"
              ? "模型调用失败"
              : integrationDraft.model.apiKeyConfigured
                ? "API Key 已保存，等待下一次模型请求验证"
                : "模型连接尚未配置"}</strong>
          {model?.state === "error" ? <p>{model.detail}</p> : null}
        </div>
        <Field label="模型供应商">
          <div className="settings-provider">
            <select
              className="input"
              aria-label="模型供应商"
              value={providerPreset?.id ?? CUSTOM_PROVIDER}
              onChange={(event) => {
                if (event.target.value === CUSTOM_PROVIDER) {
                  setIntegrationsDraft({ model: { provider: "" } });
                  return;
                }
                const preset = MODEL_PROVIDER_PRESETS.find(
                  (candidate) => candidate.id === event.target.value,
                );
                if (!preset) return;
                setIntegrationsDraft({
                  model: {
                    provider: preset.id,
                    baseUrl: preset.baseUrl,
                    model: preset.defaultModel,
                  },
                });
              }}
            >
              {MODEL_PROVIDER_PRESETS.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.label}
                </option>
              ))}
              <option value={CUSTOM_PROVIDER}>自定义 / 中转站</option>
            </select>
            {providerPreset ? null : (
              <>
                <input
                  className="input"
                  aria-label="自定义模型供应商标识"
                  value={integrationDraft.model.provider}
                  maxLength={32}
                  placeholder="例如 yyapi、proxy、vllm"
                  onChange={(event) =>
                    setIntegrationsDraft({
                      model: { provider: event.target.value },
                    })
                  }
                />
              </>
            )}
          </div>
        </Field>
        <Field label="模型名称">
          <div className="settings-model">
            <div className="settings-model__row">
              <input
                className="input"
                aria-label="模型名称"
                value={integrationDraft.model.model}
                maxLength={96}
                placeholder="deepseek-flash"
                onChange={(event) =>
                  setIntegrationsDraft({ model: { model: event.target.value } })
                }
              />
              <button
                type="button"
                className="action action--ghost settings-model__fetch"
                disabled={!canFetchModels}
                onClick={() =>
                  onFetchModels(integrationDraft.model.baseUrl, secrets.model)
                }
              >
                {modelCatalogPending ? "获取中…" : "获取模型"}
              </button>
            </div>
            {catalogForEndpoint?.ok && catalogForEndpoint.models.length > 0 ? (
              <select
                className="input"
                aria-label="选择已获取的模型"
                value={
                  catalogForEndpoint.models.includes(integrationDraft.model.model)
                    ? integrationDraft.model.model
                    : ""
                }
                onChange={(event) => {
                  if (event.target.value.length === 0) return;
                  setIntegrationsDraft({ model: { model: event.target.value } });
                }}
              >
                <option value="">从列表中选择模型（共 {catalogForEndpoint.models.length} 个）</option>
                {catalogForEndpoint.models.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
            ) : null}
            {catalogForEndpoint && !catalogForEndpoint.ok ? (
              <small className="settings-model__status" data-state="error" role="status">
                {catalogForEndpoint.detail}
              </small>
            ) : modelTargetChanged && secrets.model.trim().length === 0 ? (
              <small className="settings-model__caption">
                更换地址后需要重新输入 API Key 才能获取模型。
              </small>
            ) : null}
          </div>
        </Field>
        <Field label="模型 API 地址">
          <input
            className="input"
            value={integrationDraft.model.baseUrl}
            maxLength={240}
            onChange={(event) =>
              setIntegrationsDraft({ model: { baseUrl: event.target.value } })
            }
          />
        </Field>
        <Field
          label="模型 API Key"
          hint={
            modelTargetChanged
              ? "供应商或地址已变更，请重新输入 Key；留空会清除旧 Key"
              : integrationDraft.model.apiKeyConfigured
                ? "已保存；留空保持不变"
                : "尚未保存"
          }
        >
          <input
            className="input"
            type="password"
            value={secrets.model}
            autoComplete="new-password"
            placeholder={integrationDraft.model.apiKeyConfigured ? "••••••••（保持不变）" : "输入 API Key"}
            onChange={(event) => setSecrets((current) => ({ ...current, model: event.target.value }))}
          />
        </Field>
        <Field label="抖音房间号">
          <input
            className="input input--short"
            value={integrationDraft.douyin.roomId}
            maxLength={64}
            placeholder="未配置"
            onChange={(event) =>
              setIntegrationsDraft({ douyin: { roomId: event.target.value } })
            }
          />
        </Field>
        <Field label="dyhub 地址">
          <input
            className="input"
            value={integrationDraft.douyin.dyhubUrl}
            maxLength={200}
            placeholder="ws://127.0.0.1:8757"
            onChange={(event) =>
              setIntegrationsDraft({ douyin: { dyhubUrl: event.target.value } })
            }
          />
        </Field>
        <Field label="语音音色 ID">
          <input
            className="input"
            value={integrationDraft.voice.voiceId}
            maxLength={96}
            onChange={(event) =>
              setIntegrationsDraft({ voice: { voiceId: event.target.value } })
            }
          />
        </Field>
        <Field label="语音 API 地址">
          <input
            className="input"
            value={integrationDraft.voice.url}
            maxLength={240}
            onChange={(event) =>
              setIntegrationsDraft({ voice: { url: event.target.value } })
            }
          />
        </Field>
        <Field
          label="语音 API Key"
          hint={integrationDraft.voice.apiKeyConfigured ? "已保存；留空保持不变" : "尚未保存"}
        >
          <input
            className="input"
            type="password"
            value={secrets.voice}
            autoComplete="new-password"
            placeholder={integrationDraft.voice.apiKeyConfigured ? "••••••••（保持不变）" : "输入 API Key"}
            onChange={(event) => setSecrets((current) => ({ ...current, voice: event.target.value }))}
          />
        </Field>
      </Section>

      <Section activeTab={tab} title="界面">
        <Field label="外观">
          <Segmented
            value={preferences.theme}
            options={[
              ["system", "跟随系统"],
              ["light", "浅色"],
              ["dark", "深色"],
            ]}
            onChange={(theme) => onPreferences({ theme: theme as ThemeMode })}
          />
        </Field>
        <Field label="文字大小">
          <Segmented
            value={preferences.textScale}
            options={[
              [100, "100%"],
              [110, "110%"],
              [125, "125%"],
            ]}
            onChange={(scale) => onPreferences({ textScale: Number(scale) as TextScale })}
          />
        </Field>
        <Field label="强调色">
          <div className="swatches" role="radiogroup" aria-label="强调色">
            {(
              [
                ["pine", "松绿"],
                ["blossom", "樱粉"],
                ["ocean", "深海"],
                ["plum", "梅紫"],
              ] as const
            ).map(([accent, label]) => (
              <button
                key={accent}
                type="button"
                className="swatch"
                role="radio"
                aria-checked={preferences.accent === accent}
                aria-label={label}
                title={label}
                data-accent={accent}
                data-selected={preferences.accent === accent}
                onClick={() => onPreferences({ accent: accent as Accent })}
              />
            ))}
          </div>
        </Field>
        <Field label="减弱动态效果">
          <button
            type="button"
            className="toggle"
            role="switch"
            aria-checked={preferences.reduceMotion}
            data-on={preferences.reduceMotion}
            onClick={() => onPreferences({ reduceMotion: !preferences.reduceMotion })}
          >
            <span />
          </button>
        </Field>
      </Section>

      </fieldset>
      <div className="settings-foot">
        <p role="status">
          {validation && !validation.success
            ? `有 ${validation.error.issues.length} 项需要修正`
            : saved ?? (dirty || integrationDirty || secrets.model || secrets.voice ? "有未保存的修改" : "")}
        </p>
        <div>
          <button type="button" className="action" onClick={onResetPreferences}>
            重置界面
          </button>
          <button type="submit" className="action action--primary" disabled={!canSave}>
            {saving ? "正在保存…" : "保存并应用"}
          </button>
        </div>
      </div>
    </form>
  );
}

function Section({
  activeTab,
  title,
  children,
}: {
  readonly activeTab: string;
  readonly title: string;
  readonly children: ReactNode;
}): React.JSX.Element {
  return (
    <section className="settings-section" role="tabpanel" aria-label={title} hidden={activeTab !== title}>
      <div className="settings-section__rows">{children}</div>
    </section>
  );
}

function Field({
  label,
  hint,
  align = "row",
  children,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly align?: "row" | "stack";
  readonly children: ReactNode;
}): React.JSX.Element {
  const id = useId();
  const control = isValidElement<{ id?: string; "aria-labelledby"?: string }>(children)
    && typeof children.type === "string" && ["input", "select", "textarea", "button"].includes(children.type)
      ? cloneElement(children, { id, "aria-labelledby": `${id}-label` }) : children;
  return (
    <div className="settings-field" data-align={align}>
      <div className="settings-field__label">
        <label id={`${id}-label`} htmlFor={id}>{label}</label>
        {hint ? <small>{hint}</small> : null}
      </div>
      <div className="settings-field__control" role="group" aria-labelledby={`${id}-label`}>{control}</div>
    </div>
  );
}

function Segmented({
  value,
  options,
  onChange,
}: {
  readonly value: string | number;
  readonly options: readonly (readonly [string | number, string])[];
  readonly onChange: (value: string | number) => void;
}): React.JSX.Element {
  return (
    <div className="segmented" role="group">
      {options.map(([option, label]) => (
        <button
          key={option}
          type="button"
          data-selected={value === option}
          aria-pressed={value === option}
          onClick={() => onChange(option)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function lines(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 8);
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/u, "");
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
