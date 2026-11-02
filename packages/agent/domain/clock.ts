/** Time and identity are injected so the domain stays deterministic in tests. */
export interface Clock {
  now(): number;
  newId(): string;
}
