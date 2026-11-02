import type { Clock } from "../../domain/index.ts";

export type { Clock };

export const systemClock: Clock = {
  now: () => Date.now(),
  newId: () => crypto.randomUUID(),
};
