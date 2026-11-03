import { MAX_UTTERANCE_CHARS } from "@craftmate/contracts";

const SENTENCE_END = /[。！？!?；;…]/;
const SOFT_BREAK = /[，,、：:]/;

/**
 * Splits spoken text into short, TTS-friendly units. Punctuation stays with
 * the sentence that owns it so the subtitle reads naturally, and no unit ever
 * exceeds the configured limit.
 */
export function splitUtterance(text: string, maxChars = MAX_UTTERANCE_CHARS): string[] {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) return [];
  if (maxChars < 1) throw new RangeError("maxChars must be positive");

  const sentences: string[] = [];
  let buffer = "";

  for (const char of normalized) {
    buffer += char;
    if (SENTENCE_END.test(char)) {
      push(sentences, buffer, maxChars);
      buffer = "";
    }
  }
  push(sentences, buffer, maxChars);

  return mergeShort(sentences, maxChars);
}

function push(target: string[], raw: string, maxChars: number): void {
  const text = raw.trim();
  if (text.length === 0) return;
  if (text.length <= maxChars) {
    target.push(text);
    return;
  }
  for (const piece of splitLong(text, maxChars)) target.push(piece);
}

/** Prefer a comma boundary before hard-cutting at the character limit. */
function splitLong(text: string, maxChars: number): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars);
    let cut = -1;
    for (let index = window.length - 1; index > 0; index -= 1) {
      const char = window[index];
      if (char !== undefined && SOFT_BREAK.test(char)) {
        cut = index + 1;
        break;
      }
    }
    if (cut <= 0) cut = maxChars;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest.length > 0) parts.push(rest);
  return parts;
}

/**
 * Very short fragments sound choppy when synthesized separately. Merge them
 * only when the combined unit still fits.
 */
function mergeShort(parts: string[], maxChars: number): string[] {
  // Keep sentence boundaries intact: merging would change both subtitle
  // timing and the unit at which a higher-priority utterance may preempt.
  void maxChars;
  return parts;
}
