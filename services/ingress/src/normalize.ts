import type { AudienceEvent, SourceHealth } from "@craftmate/contracts";
import type { DanmakuEvent } from "./dyhub.ts";

const MAX_TEXT = 500;
const MAX_NICK = 40;

export type NormalizeResult =
  | { readonly kind: "event"; readonly event: AudienceEvent }
  | { readonly kind: "health"; readonly health: SourceHealth }
  | { readonly kind: "drop"; readonly reason: string };

/**
 * dyhub's normalized event into our untrusted-evidence shape.
 *
 * `roomStatus` is health, not audience input: turning "room closed" into a
 * comment would let a platform control frame reach the arbiter as an empty
 * message and show up as a phantom decision.
 */
export function normalize(raw: DanmakuEvent, now = Date.now()): NormalizeResult {
  // Room status is a control frame from the platform, not a person: it carries
  // no user and must be classified before the user guard below.
  if (raw.type === "roomStatus") {
    const status = String(raw.data?.status ?? "");
    const message = typeof raw.data?.message === "string" ? raw.data.message : "";
    if (status === "live" || status === "connecting") {
      return { kind: "health", health: { state: "open", detail: status, lastEventAt: now } };
    }
    if (status === "closed") {
      return { kind: "health", health: { state: "closed", detail: "直播间已关闭", lastEventAt: null } };
    }
    return {
      kind: "health",
      health: { state: "error", detail: message || status || "unknown", lastEventAt: null },
    };
  }

  const user = raw.user;
  const nickname = (user?.nickname ?? "").slice(0, MAX_NICK);
  const userId = String(user?.id ?? "");
  if (userId.length === 0) return { kind: "drop", reason: "missing user id" };

  const ts = raw.ts ?? raw.receivedAt ?? now;

  switch (raw.type) {
    case "chat": {
      const content = typeof raw.data?.content === "string" ? raw.data.content.trim() : "";
      if (content.length === 0) return { kind: "drop", reason: "empty chat" };
      return {
        kind: "event",
        event: {
          id: raw.id,
          source: "douyin",
          kind: "comment",
          userId,
          nickname: nickname || "观众",
          text: content.slice(0, MAX_TEXT),
          ts,
        },
      };
    }

    case "gift": {
      const name = typeof raw.data?.giftName === "string" ? raw.data.giftName : "礼物";
      const count = numberOf(raw.data?.repeatCount) ?? numberOf(raw.data?.groupCount) ?? 1;
      const value = numberOf(raw.data?.diamondCount) ?? 0;
      return {
        kind: "event",
        event: {
          id: raw.id,
          source: "douyin",
          kind: "gift",
          userId,
          nickname: nickname || "观众",
          gift: { name, count: Math.max(1, count), value },
          ts,
        },
      };
    }

    case "member":
      return { kind: "event", event: base(raw, userId, nickname || "观众", "enter", ts) };

    case "like":
      return { kind: "event", event: base(raw, userId, nickname || "观众", "like", ts) };

    case "room": {
      const total = numberOf(raw.data?.total);
      if (total === null) return { kind: "drop", reason: "room event without count" };
      return { kind: "event", event: base(raw, "room", "直播间", "viewer_count", ts) };
    }

    case "follow":
      return { kind: "drop", reason: "follow is not an audience command" };

    default:
      return { kind: "drop", reason: `unsupported type ${raw.type}` };
  }
}

function base(
  raw: DanmakuEvent,
  userId: string,
  nickname: string,
  kind: AudienceEvent["kind"],
  ts: number,
): AudienceEvent {
  return { id: raw.id, source: "douyin", kind, userId, nickname, ts };
}

function numberOf(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return null;
}
