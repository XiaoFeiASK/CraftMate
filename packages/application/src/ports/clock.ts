/** Time and identity are injected so the domain stays deterministic in tests. */
export interface Clock {
  now(): number;
  newId(): string;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  newId: () => crypto.randomUUID(),
};
