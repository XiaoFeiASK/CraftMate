import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { showSettingsSchema, type PersonaProfile, type ShowSettings } from "@craftmate/contracts";
import type { WireState } from "../../lib/connection.ts";
import type { Accent, Preferences, TextScale, ThemeMode } from "../../lib/preferences.ts";

interface SettingsViewProps {
  readonly settings: ShowSettings | null;
  readonly state: WireState;
  readonly preferences: Preferences;
  readonly onPreferences: (patch: Partial<Preferences>) => void;
  readonly onResetPreferences: () => void;
  readonly onSave: (next: ShowSettings) => void;
}

const VALUE_LABEL = "每行一条，最多 8 条";

export function SettingsView({
  settings,
  state,
  preferences,
  onPreferences,
  onResetPreferences,
  onSave,
}: SettingsViewProps): React.JSX.Element {
  const [draft, setDraft] = useState<ShowSettings | null>(settings);
  const [saved, setSaved] = useState<string | null>(null);
  /** Raw textarea text so pressing Enter is not normalised away mid-edit. */
  const [listDrafts, setListDrafts] = useState<{ values: string; boundaries: string } | null>(null);
  const savedSnapshot = useRef<string>(settings ? JSON.stringify(settings) : "");
  const draftRef = useRef(draft);
  const pendingSave = useRef(false);

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
    if (!settings || !pendingSave.current) return;
    if (draft && JSON.stringify(draft) === JSON.stringify(settings)) {
      pendingSave.current = false;
      savedSnapshot.current = JSON.stringify(settings);
      setSaved("已保存到当前场次");
    }
  }, [settings, draft]);

  const validation = useMemo(
    () => (draft ? showSettingsSchema.safeParse(draft) : null),
    [draft],
  );
  const dirty = draft !== null && settings !== null && JSON.stringify(draft) !== JSON.stringify(settings);
  const canSave = state === "open" && dirty && validation?.success === true;

  if (!draft) {
    return (
      <div className="settings-view">
        <p className="panel-note">正在从本地内核读取配置。</p>
      </div>
    );
  }

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (!canSave || !validation?.success) return;
    pendingSave.current = true;
    onSave(validation.data);
    setSaved("正在保存…");
  };

  const patch = (next: Partial<ShowSettings>): void => {
    setDraft((current) => (current ? { ...current, ...next } : current));
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

  const patchList = (field: "values" | "boundaries", text: string): void => {
    setListDrafts({ ...listText, [field]: text });
    patchPersona({ [field]: lines(text) });
  };

  return (
    <form className="settings-view" onSubmit={submit}>
      <Section title="直播资料" hint="保存后立即写入 SQLite，并在下次启动时恢复">
        <Field label="今日主线" hint="显示在总览卡片上的当前目标">
          <input
            className="input"
            value={draft.goal}
            maxLength={120}
            onChange={(event) => patch({ goal: event.target.value })}
          />
        </Field>
        <Field label="主线进度" hint="Bridge 接入前由操作员手动推进">
          <div className="slider-row">
            <input
              className="slider"
              type="range"
              min={0}
              max={100}
              step={1}
              value={draft.goalProgress}
              onChange={(event) => patch({ goalProgress: Number(event.target.value) })}
            />
            <output>{draft.goalProgress}%</output>
          </div>
        </Field>
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
        <Field label="账号说明" hint="侧栏账户卡片下的那行小字">
          <input
            className="input"
            value={draft.accountLabel}
            maxLength={40}
            onChange={(event) => patch({ accountLabel: event.target.value })}
          />
        </Field>
      </Section>

      <Section title="角色与人格" hint="权重会直接进入仲裁打分，不只是展示">
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

      <Section title="接入" hint="留空表示尚未接入，界面不会假装在线">
        <Field label="抖音房间号">
          <input
            className="input input--short"
            value={draft.integrations.douyinRoomId}
            maxLength={64}
            placeholder="未配置"
            onChange={(event) =>
              patch({
                integrations: { ...draft.integrations, douyinRoomId: event.target.value },
              })
            }
          />
        </Field>
        <Field label="模型">
          <input
            className="input input--short"
            value={draft.integrations.deepseekModel}
            maxLength={64}
            placeholder="未配置"
            onChange={(event) =>
              patch({
                integrations: { ...draft.integrations, deepseekModel: event.target.value },
              })
            }
          />
        </Field>
        <Field label="音色" hint="供应商 / 音色 ID">
          <div className="inline-pair">
            <input
              className="input"
              value={draft.persona.voice.provider}
              maxLength={32}
              onChange={(event) =>
                patchPersona({ voice: { ...draft.persona.voice, provider: event.target.value } })
              }
            />
            <input
              className="input"
              value={draft.persona.voice.voiceId}
              maxLength={48}
              onChange={(event) =>
                patchPersona({ voice: { ...draft.persona.voice, voiceId: event.target.value } })
              }
            />
          </div>
        </Field>
      </Section>

      <Section title="界面" hint="只保存在这台机器，立即生效，不写入直播数据">
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
        <Field label="减弱动态效果" hint="关闭场景淡入、卡片上浮与角色摆动">
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

      <div className="settings-foot">
        <p role="status">
          {validation && !validation.success
            ? `有 ${validation.error.issues.length} 项需要修正`
            : saved ?? (dirty ? "有未保存的修改" : "配置与本地内核一致")}
        </p>
        <div>
          <button type="button" className="action" onClick={onResetPreferences}>
            重置界面
          </button>
          <button type="submit" className="action action--primary" disabled={!canSave}>
            保存到本场
          </button>
        </div>
      </div>
    </form>
  );
}

function Section({
  title,
  hint,
  children,
}: {
  readonly title: string;
  readonly hint: string;
  readonly children: ReactNode;
}): React.JSX.Element {
  return (
    <section className="settings-section">
      <header>
        <h3>{title}</h3>
        <p>{hint}</p>
      </header>
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
  return (
    <div className="settings-field" data-align={align}>
      <div className="settings-field__label">
        <strong>{label}</strong>
        {hint ? <small>{hint}</small> : null}
      </div>
      <div className="settings-field__control">{children}</div>
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
