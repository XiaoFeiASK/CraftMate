export const clock = (timestamp: number): string =>
  new Date(timestamp).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

export const signed = (value: number): string => (value > 0 ? `+${value}` : String(value));

export const ratio = (part: number, total: number): number => (total <= 0 ? 0 : Math.round((part / total) * 100));
