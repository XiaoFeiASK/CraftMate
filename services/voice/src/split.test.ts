import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { MAX_UTTERANCE_CHARS } from "@craftmate/contracts";
import { sentencePauseMs, splitUtterance } from "./split.ts";

describe("utterance splitting", () => {
  test("keeps punctuation and never exceeds the limit", () => {
    const parts = splitUtterance("唔，知道了！我这就去挖铁矿。你等着看吧。");
    assert.deepEqual(parts, ["唔，知道了！", "我这就去挖铁矿。", "你等着看吧。"]);
    assert.ok(parts.every((part) => part.length <= MAX_UTTERANCE_CHARS));
  });

  test("splits an unpunctuated long sentence on a soft boundary", () => {
    const parts = splitUtterance(
      "我跟你说这个真的特别特别好吃，你要不要也来一口试试看，我保证你吃了还想再吃，真的不骗你",
    );
    assert.ok(parts.length > 1);
    assert.ok(parts.every((part) => part.length <= MAX_UTTERANCE_CHARS));
  });

  test("hard-cuts text with no usable boundary", () => {
    const parts = splitUtterance("啊".repeat(100));
    assert.ok(parts.every((part) => part.length <= MAX_UTTERANCE_CHARS));
    assert.equal(parts.join("").length, 100);
  });

  test("empty and whitespace-only text produces nothing", () => {
    assert.deepEqual(splitUtterance(""), []);
    assert.deepEqual(splitUtterance("   \n "), []);
  });

  test("folds a tiny opening fragment into the sentence that follows", () => {
    assert.deepEqual(splitUtterance("唔。知道了，我这就去。"), ["唔。知道了，我这就去。"]);
    assert.deepEqual(splitUtterance("好！我马上回来。"), ["好！我马上回来。"]);
  });

  test("sentence pauses follow the punctuation a speaker wrote", () => {
    assert.ok(sentencePauseMs("那我走啦。") > sentencePauseMs("那我就去啦，"));
    assert.ok(sentencePauseMs("真的吗？") > sentencePauseMs("真的吗，"));
    assert.ok(sentencePauseMs("等等……") > sentencePauseMs("等等。"));
    assert.ok(sentencePauseMs("没有标点") > 0);
  });
});
