import { z } from "zod";
import { audienceEventSchema } from "@craftmate/protocol";

export const operatorActionSchema = z.object({
  kind: z.enum(["whisper", "takeover", "release", "stop"]),
  text: z.string(),
});

export type OperatorAction = z.infer<typeof operatorActionSchema>;

export const clientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello") }),
  z.object({ type: z.literal("comment"), payload: audienceEventSchema }),
  z.object({ type: z.literal("operator"), payload: operatorActionSchema }),
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;
