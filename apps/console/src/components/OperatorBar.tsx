import { useState, type FormEvent } from "react";
import type { OperatorKind } from "../lib/wire.ts";

interface OperatorBarProps {
  readonly onComment: (nickname: string, text: string) => void;
  readonly onOperator: (kind: OperatorKind, text?: string) => void;
  readonly onBurst: () => void;
  readonly disabled: boolean;
}

export function OperatorBar({ onComment, onOperator, onBurst, disabled }: OperatorBarProps): React.JSX.Element {
  const [text, setText] = useState("");
  const [whisperOpen, setWhisperOpen] = useState(false);
  const [whisper, setWhisper] = useState("");

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const value = text.trim();
    if (!value) return;
    onComment("操作员", value);
    setText("");
  };

  const submitWhisper = (event: FormEvent): void => {
    event.preventDefault();
    const value = whisper.trim();
    if (!value) return;
    onOperator("whisper", value);
    setWhisper("");
    setWhisperOpen(false);
  };

  return (
    <footer className="bar">
      {whisperOpen ? (
        <form className="bar__whisper" onSubmit={submitWhisper}>
          <label htmlFor="whisper">只对 {`大肥鱼`} 说，不进直播间</label>
          <input
            id="whisper"
            value={whisper}
            onChange={(event) => setWhisper(event.target.value)}
            placeholder="先别真跳，吓唬一下"
            disabled={disabled}
            autoComplete="off"
            autoFocus
          />
          <button type="submit" className="bar__submit" disabled={disabled || whisper.trim().length === 0}>
            耳语
          </button>
        </form>
      ) : null}

      <form className="bar__input" onSubmit={submit}>
        <label htmlFor="say">以观众身份发一条</label>
        <input
          id="say"
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="去挖点铁矿"
          disabled={disabled}
          autoComplete="off"
        />
        <button type="submit" className="bar__submit" disabled={disabled || text.trim().length === 0}>
          发送
        </button>
      </form>

      <div className="bar__actions">
        <button type="button" className="action action--ghost" onClick={() => onOperator("takeover", "操作员接管")} disabled={disabled}>
          接管
        </button>
        <button type="button" className="action action--ghost" onClick={() => onOperator("release", "操作员释放")} disabled={disabled}>
          释放
        </button>
        <button
          type="button"
          className="action action--ghost"
          aria-expanded={whisperOpen}
          onClick={() => setWhisperOpen((open) => !open)}
          disabled={disabled}
        >
          耳语
        </button>
        <button type="button" className="action action--stop" onClick={() => onOperator("stop", "急停")} disabled={disabled}>
          急停
        </button>
        <button type="button" className="action action--quiet" onClick={onBurst} disabled={disabled}>
          模拟一波
        </button>
      </div>
    </footer>
  );
}
