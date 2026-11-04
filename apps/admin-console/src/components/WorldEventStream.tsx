import type { BodyEvent } from "@craftmate/contracts";
import { clock } from "../lib/format.ts";

const EVENT_LABELS: Record<string, string> = {
  reflex: "身体避险",
};

const REFLEX_LABELS: Record<string, string> = {
  lava: "岩浆",
  low_health: "低血",
  falling: "坠落",
  drowning: "溺水",
  on_fire: "着火",
  starving: "饥饿",
  creeper: "苦力怕",
};

interface WorldEventStreamProps {
  readonly events: readonly BodyEvent[];
}

/**
 * Decisions explain what the show asked for. World events explain what the
 * body actually lived through, including the moments it refused to continue.
 * Keep the newest few visible next to the decision stream so "why did it stop"
 * does not require opening another drawer.
 */
export function WorldEventStream({ events }: WorldEventStreamProps): React.JSX.Element | null {
  if (events.length === 0) return null;

  return (
    <section className="world-events" aria-labelledby="world-events-title">
      <header className="world-events__head">
        <h3 id="world-events-title">身体事件</h3>
        <span>{events.length}</span>
      </header>
      <ol className="world-events__list">
        {events.slice(0, 6).map((event, index) => {
          const summary = describe(event);
          return (
            <li key={`${event.at}-${index}`} className="world-events__item" data-name={event.name}>
              <span className="world-events__badge">{EVENT_LABELS[event.name] ?? event.name}</span>
              <p>{summary.detail}</p>
              {summary.health === undefined ? null : (
                <small>生命 {summary.health.toFixed(1)}</small>
              )}
              <time dateTime={new Date(event.at).toISOString()}>{clock(event.at)}</time>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function describe(event: BodyEvent): { readonly detail: string; readonly health?: number } {
  if (event.name === "reflex" && isRecord(event.data)) {
    const kind = typeof event.data.kind === "string" ? event.data.kind : "unknown";
    const detail = typeof event.data.detail === "string" ? event.data.detail : kind;
    const health = typeof event.data.health === "number" ? event.data.health : undefined;
    const label = REFLEX_LABELS[kind] ?? kind;
    return {
      detail: `${label} · ${detail}`,
      ...(health === undefined ? {} : { health }),
    };
  }
  return { detail: compact(event.data) };
}

function compact(data: unknown): string {
  if (typeof data === "string") return data;
  if (data === null || data === undefined) return "—";
  try {
    const text = JSON.stringify(data);
    return text.length > 120 ? `${text.slice(0, 117)}…` : text;
  } catch {
    return "无法显示";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
