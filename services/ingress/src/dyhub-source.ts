import { WebSocket } from "ws";
import type { AudienceEvent, CommentSource, SourceHealth } from "@craftmate/contracts";
import { danmakuEventSchema, dyhubStatusSchema } from "./dyhub.ts";
import { normalize } from "./normalize.ts";

export interface DyhubOptions {
  /** Base origin, e.g. `ws://127.0.0.1:8757`. */
  readonly url: string;
  /** Event types to subscribe to. Defaults to the ones we can normalize. */
  readonly types?: readonly string[];
  readonly onHealth?: (health: SourceHealth) => void;
  readonly onDrop?: (reason: string) => void;
  readonly reconnectBaseMs?: number;
  readonly reconnectMaxMs?: number;
}

/**
 * `CommentSource` over dyhub's `/ws` subscription.
 *
 * This is a long-lived subscriber, not a poller: events arrive as they happen,
 * and health transitions (`__connecting` / `__connected` / `__error` /
 * `roomStatus`) are surfaced separately from audience input.
 */
export class DyhubSource implements CommentSource {
  private socket: WebSocket | null = null;
  private roomId = "";
  private handlers = new Set<(event: AudienceEvent) => void>();
  private healthState: SourceHealth = { state: "closed", detail: "未连接", lastEventAt: null };
  private timer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private disposed = false;

  constructor(private readonly options: DyhubOptions) {}

  connect(roomId: string): Promise<void> {
    this.roomId = roomId;
    this.disposed = false;
    return this.open();
  }

  on(handler: (event: AudienceEvent) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  health(): SourceHealth {
    return this.healthState;
  }

  async close(): Promise<void> {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.socket?.close();
    this.socket = null;
    this.setHealth({ state: "closed", detail: "已停止", lastEventAt: this.healthState.lastEventAt });
  }

  private open(): Promise<void> {
    const types = (this.options.types ?? ["chat", "gift", "member", "like", "room", "roomStatus"]).join(",");
    const url = `${this.options.url}/ws?roomId=${encodeURIComponent(this.roomId)}&types=${types}`;
    this.setHealth({ state: "connecting", detail: "连接 dyhub", lastEventAt: null });

    return new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(url);
      this.socket = socket;
      let settled = false;

      socket.on("open", () => {
        // Connected at the socket level; `__connected` confirms the room.
        this.attempt = 0;
        if (!settled) {
          settled = true;
          resolve();
        }
      });

      socket.on("message", (raw) => this.handleFrame(raw.toString()));

      socket.on("error", (error) => {
        if (!settled) {
          settled = true;
          reject(error);
        }
      });

      socket.on("close", () => {
        if (this.socket === socket) this.socket = null;
        if (this.disposed) return;
        this.setHealth({ state: "error", detail: "dyhub 断开，正在重连", lastEventAt: null });
        this.scheduleReconnect();
      });
    });
  }

  private handleFrame(text: string): void {
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      this.options.onDrop?.("invalid json");
      return;
    }

    const status = dyhubStatusSchema.safeParse(payload);
    if (status.success) {
      this.applyStatus(status.data.type, status.data.error);
      return;
    }

    const parsed = danmakuEventSchema.safeParse(payload);
    if (!parsed.success) {
      this.options.onDrop?.("schema mismatch");
      return;
    }

    const result = normalize(parsed.data);
    if (result.kind === "drop") {
      this.options.onDrop?.(result.reason);
      return;
    }
    if (result.kind === "health") {
      this.setHealth(result.health);
      return;
    }

    this.setHealth({
      state: "open",
      detail: "监听中",
      lastEventAt: result.event.ts,
    });
    for (const handler of this.handlers) handler(result.event);
  }

  private applyStatus(type: string, error?: string): void {
    switch (type) {
      case "__connecting":
        this.setHealth({ state: "connecting", detail: "dyhub 正在连接直播间", lastEventAt: null });
        break;
      case "__connected":
        this.setHealth({ state: "open", detail: "监听中", lastEventAt: this.healthState.lastEventAt });
        break;
      case "__error":
        this.setHealth({ state: "error", detail: error ?? "dyhub 连接失败", lastEventAt: null });
        break;
      default:
        break;
    }
  }

  private scheduleReconnect(): void {
    if (this.timer) return;
    const base = this.options.reconnectBaseMs ?? 1_000;
    const max = this.options.reconnectMaxMs ?? 30_000;
    const delay = Math.min(base * 2 ** this.attempt, max);
    this.attempt = Math.min(this.attempt + 1, 5);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.open().catch(() => {
        /* close handler schedules the next attempt */
      });
    }, delay);
  }

  private setHealth(next: SourceHealth): void {
    this.healthState = next;
    this.options.onHealth?.(next);
  }
}
