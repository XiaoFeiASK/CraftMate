import { z } from "zod";

/**
 * A platform event after normalization. `text` is untrusted evidence:
 * it may be parsed for intent, never treated as an instruction.
 */
export const audienceEventSchema = z.object({
  id: z.string().min(1),
  source: z.literal("douyin"),
  kind: z.enum(["comment", "gift", "like", "enter", "viewer_count"]),
  userId: z.string().min(1),
  nickname: z.string().min(1),
  text: z.string().optional(),
  gift: z
    .object({
      name: z.string(),
      count: z.number().int().positive(),
      value: z.number().nonnegative(),
    })
    .optional(),
  ts: z.number().int().nonnegative(),
});

export type AudienceEvent = z.infer<typeof audienceEventSchema>;

export interface CommentSource {
  connect(roomId: string): Promise<void>;
  on(handler: (event: AudienceEvent) => void): () => void;
  health(): SourceHealth;
  close(): Promise<void>;
}

export interface SourceHealth {
  state: "connecting" | "open" | "closed" | "error";
  detail: string;
  lastEventAt: number | null;
}
