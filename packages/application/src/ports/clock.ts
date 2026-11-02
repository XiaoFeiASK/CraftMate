import type { Clock } from "@craftmate/domain";

export type { Clock } from "@craftmate/domain";

export const systemClock: Clock = {
  now: () => Date.now(),
  newId: () => crypto.randomUUID(),
};
