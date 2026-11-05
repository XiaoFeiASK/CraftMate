import { z } from "zod";
import { audienceEventSchema, sourceHealthSchema } from "./audience.ts";
import { ingressMetricsFrameSchema } from "./telemetry.ts";

/**
 * Ingress is a local, trusted-by-token data source. It may submit normalized
 * events and health, but it can never issue operator commands.
 */
export const ingressHelloSchema = z.object({
  type: z.literal("hello"),
  role: z.literal("ingress"),
  token: z.string().min(1),
});
export type IngressHello = z.infer<typeof ingressHelloSchema>;

export const ingressClientFrameSchema = z.discriminatedUnion("type", [
  ingressHelloSchema,
  z.object({ type: z.literal("event"), payload: audienceEventSchema }),
  z.object({ type: z.literal("health"), payload: sourceHealthSchema }),
  z.object({ type: z.literal("metrics"), payload: ingressMetricsFrameSchema }),
]);
export type IngressClientFrame = z.infer<typeof ingressClientFrameSchema>;

export const ingressReadySchema = z.object({
  type: z.literal("ready"),
  payload: z.object({
    sessionId: z.string().min(1),
    heartbeatMs: z.number().int().positive(),
  }),
});
export type IngressReady = z.infer<typeof ingressReadySchema>;

export const ingressServerFrameSchema = z.discriminatedUnion("type", [
  ingressReadySchema,
  z.object({
    type: z.literal("error"),
    payload: z.object({ code: z.string(), detail: z.string() }),
  }),
]);
export type IngressServerFrame = z.infer<typeof ingressServerFrameSchema>;

export const INGRESS_CLOSE_UNAUTHORIZED = 4401;
export const INGRESS_CLOSE_REMOTE = 4403;
