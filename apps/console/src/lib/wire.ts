import type { Decision } from "@craftmate/protocol";

export type WireState = "connecting" | "open" | "closed" | "error";

export type OperatorKind = "whisper" | "takeover" | "release" | "stop";
export type ShowMode = "agent" | "operator" | "stopped";

export interface Stats {
  readonly received: number;
  readonly executed: number;
  readonly refused: number;
  readonly observed: number;
  readonly openCommitments: number;
}

export interface Snapshot {
  readonly mode: ShowMode;
  readonly stats: Stats;
  readonly decisions: readonly Decision[];
}

export interface Persona {
  readonly id: string;
  readonly name: string;
  readonly identity: string;
  readonly weights: Record<string, number>;
}

export type ServerMessage =
  | { readonly type: "ready"; readonly payload: { readonly persona: Persona; readonly snapshot: Snapshot } }
  | { readonly type: "decision"; readonly payload: Decision }
  | { readonly type: "stats"; readonly payload: Stats }
  | { readonly type: "snapshot"; readonly payload: Snapshot }
  | { readonly type: "operator"; readonly payload: { readonly kind: OperatorKind; readonly text: string } }
  | { readonly type: "error"; readonly payload: { readonly code: string; readonly detail: string } };
