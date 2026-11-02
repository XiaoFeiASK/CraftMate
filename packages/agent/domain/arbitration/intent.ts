import type { AudienceEvent, Intent } from "@craftmate/contracts";

interface IntentRule {
  readonly intent: Intent;
  readonly keywords: readonly string[];
}

const RULES: readonly IntentRule[] = [
  { intent: "danger", keywords: ["跳岩浆", "岩浆", "tnt", "炸掉", "自杀", "跳崖", "掉下去"] },
  { intent: "mine", keywords: ["挖矿", "挖", "矿", "钻石", "铁矿", "煤", "砍树"] },
  { intent: "build", keywords: ["盖房", "建", "造", "房子", "墙", "搭"] },
  { intent: "craft", keywords: ["合成", "工作台", "熔炉", "箱子", "床", "剑", "镐"] },
  { intent: "eat", keywords: ["吃", "饿", "白饭", "面包"] },
  { intent: "follow", keywords: ["跟着我", "跟随", "跟我"] },
  { intent: "move", keywords: ["过去", "过来", "回来", "回家", "上来", "下去"] },
  { intent: "spam", keywords: ["666", "哈哈哈", "啊啊啊"] },
] as const;

const PUNCTUATION = /[\s\p{P}\p{S}]/gu;

export const normalizeText = (text: string): string =>
  text.normalize("NFKC").toLowerCase().replace(PUNCTUATION, "");

export interface IntentResult {
  readonly intent: Intent;
  readonly confidence: number;
}

export function classifyIntent(event: AudienceEvent): IntentResult {
  if (event.kind !== "comment") return { intent: "chat", confidence: 0.4 };

  const text = normalizeText(event.text ?? "");
  if (text.length === 0) return { intent: "unknown", confidence: 0.9 };
  if (text.length <= 2 && /^\d+$/u.test(text)) return { intent: "spam", confidence: 0.7 };

  const match = RULES.find((rule) => rule.keywords.some((keyword) => text.includes(normalizeText(keyword))));
  if (!match) return { intent: "chat", confidence: 0.35 };

  return { intent: match.intent, confidence: 0.85 };
}
