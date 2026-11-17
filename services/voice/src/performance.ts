export type VoiceEmotion =
  | "neutral"
  | "playful"
  | "happy"
  | "excited"
  | "surprised"
  | "scared"
  | "tired"
  | "focused";

export interface VoicePerformance {
  readonly emotion: VoiceEmotion;
  /** 1 = light, 2 = clear, 3 = strong. */
  readonly intensity: 1 | 2 | 3;
  /** Added to the configured speed, never replacing the operator setting. */
  readonly pace: number;
  readonly direction: string;
}

const DANGER =
  /岩浆|着火|苦力怕|僵尸|骷髅|危险|救命|糟了|完了|血不|快跑|撤退|躲|别过来/u;
const EXCITEMENT =
  /挖到了|找到了|终于|太好了|成功了|成了|耶|哈哈|太棒|牛啊|发财|钻石/u;
const TIRED = /累了|困了|好饿|饿死|烦|唉|算了|又没|失败|没成|撑不住/u;
const SURPRISE = /诶|咦|啊\?|啊？|真的|竟然|居然|哇|没想到/u;
const PLAYFUL = /哼|才不|笨蛋|讨厌|略略|嘿嘿|猜|肥鱼|你猜|不服/u;
const FOCUSED = /先|继续|准备|下一步|需要|得去|要做/u;

/**
 * Text is the only reliable signal the voice service has about the moment.
 * Derive a small, bounded performance direction from it so the realtime model
 * gets a scene, not just a string to read. This never changes the spoken text.
 */
export function deriveVoicePerformance(text: string): VoicePerformance {
  const intensity: 1 | 2 | 3 =
    /[！!]{2,}|[?？]{2,}|[~～]/u.test(text)
      ? 3
      : /[！!?？]/u.test(text)
        ? 2
        : 1;

  if (DANGER.test(text)) {
    return {
      emotion: "scared",
      intensity,
      pace: 0.07,
      direction:
        "气息短一点，语速略快，像真的遇到危险；句尾收住，不要播音腔。",
    };
  }
  if (EXCITEMENT.test(text)) {
    return {
      emotion: "excited",
      intensity,
      pace: 0.05,
      direction:
        "像刚发现宝贝一样，声音带笑、音调上扬，重音落在结果上。",
    };
  }
  if (TIRED.test(text)) {
    return {
      emotion: "tired",
      intensity,
      pace: -0.06,
      direction:
        "放慢一点，带一点叹气或委屈，但不要哭腔，也不要拖成念稿。",
    };
  }
  if (SURPRISE.test(text)) {
    return {
      emotion: "surprised",
      intensity,
      pace: 0.02,
      direction: "开头像轻轻吸了口气，真的没想到；别把每个字都咬重。",
    };
  }
  if (PLAYFUL.test(text)) {
    return {
      emotion: "playful",
      intensity,
      pace: 0.02,
      direction:
        "像跟熟人斗嘴，带一点坏笑和撒娇；停顿自然，尾音别端平。",
    };
  }
  if (FOCUSED.test(text)) {
    return {
      emotion: "focused",
      intensity,
      pace: 0,
      direction: "像边干活边随口说话，语气放松，重点词稍微加重。",
    };
  }
  return {
    emotion: "neutral",
    intensity,
    pace: 0,
    direction:
      "像在直播间跟人聊天，允许自然换气和停顿；不要客服腔，不要逐字念稿。",
  };
}

/**
 * The realtime endpoint takes one instruction string per session. Keep the
 * operator's persona text intact and append the scene direction for this line.
 */
export function performanceInstructions(
  base: string,
  performance: VoicePerformance,
): string {
  return [
    base.trim(),
    "表演方式：你是一个活人，不是朗读器；台词必须逐字保留，但语气、停顿和气息要跟着当下的情绪走。",
    `这一句：${performance.direction}`,
    performance.intensity >= 3
      ? "情绪可以明显一点，但不要喊，也不要夸张成配音。"
      : performance.intensity === 2
        ? "情绪清楚，但保持日常说话的分寸。"
        : "收着说，像随口一讲。",
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}
