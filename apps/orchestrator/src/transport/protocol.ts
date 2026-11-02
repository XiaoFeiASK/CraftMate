import type { ShowSnapshot } from "@craftmate/application";
import type { Persona } from "@craftmate/domain";
import type { Decision } from "@craftmate/protocol";
import type { OperatorAction } from "./messages.ts";

export type ServerMessage =
  | { readonly type: "ready"; readonly payload: ReadyPayload }
  | { readonly type: "decision"; readonly payload: Decision }
  | { readonly type: "stats"; readonly payload: ShowSnapshot["stats"] }
  | { readonly type: "snapshot"; readonly payload: ShowSnapshot }
  | { readonly type: "operator"; readonly payload: OperatorAction }
  | { readonly type: "error"; readonly payload: { readonly code: string; readonly detail: string } };

export interface ReadyPayload {
  readonly persona: Persona;
  readonly snapshot: ShowSnapshot;
}
