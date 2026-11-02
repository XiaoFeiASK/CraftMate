export type ShowMode = "agent" | "operator" | "stopped";

export type OperatorKind = "takeover" | "release" | "whisper" | "stop";

export interface OperatorCommand {
  readonly kind: OperatorKind;
  readonly text: string;
}
