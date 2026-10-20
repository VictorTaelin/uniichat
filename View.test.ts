// View test
// =========
// `bun test View.test.ts`. What a view draws of the server's messages.

import { expect, test } from "bun:test";
import { LABELS } from "./Pick.ts";
import * as View from "./View.ts";

const tail = (v: View.View) => View.view_tail(v).map((row) => (row.$ === "Cap" ? row.text : row.$));

// a turn waiting on its model names the model the server says: the
// wait holds it, so no pick (none yet) can name none
test("a turn's wait names its model", () => {
  const v = View.view_new();
  View.view_hear(v, { $: "state", ...v, wait: "claude-opus-5-5", pick: null });
  expect(tail(v)).toEqual(["waiting for claude-opus-5-5…"]);
  View.view_hear(v, { $: "state", ...v, wait: View.SUMMARIES });
  expect(tail(v)).toEqual(["compressing earlier messages…"]);
  View.view_hear(v, { $: "state", ...v, wait: "" });
  expect(tail(v)).toEqual([]);
});

// each knob's menu offers every vendor's values, the pick's alone marked
test("a knob's menu lists every value", () => {
  const v = View.view_new();
  const pick = { vendor: "claude-api", model: "opus-5.5", effort: "high", speed: "fast" } as const;
  View.view_hear(v, { $: "state", ...v, vendors: ["claude-api", "openai-api"], models: LABELS, pick });
  const [model, effort, speed] = View.view_pick(v).map((k) => k.choices);
  expect(model.map((c) => c.text)).toContain("gpt-6-astra");
  expect([model, effort, speed].map((k) => k.filter((c) => c.here).map((c) => c.text))).toEqual([["opus-5.5"], ["high"], ["fast"]]);
});
