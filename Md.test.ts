// Md test
// =======
// `bun test Md.test.ts`. How the little markdown of a message reads.

import { expect, test } from "bun:test";
import * as Md from "./Md.ts";
import * as Paint from "./Paint.ts";
import * as View from "./View.ts";
import * as Html from "./web/src/Html.ts";

const kinds = (src: string) => Md.md_parse(src).map((b) => (b.$ === "List" ? "List:" + (b.k ? "1." : "-") + b.x.length : b.$));

// a list is of one kind: numbered items after bullets start a list of
// their own, and bullets after numbered ones
test("a list holds items of one kind", () => {
  expect(kinds("- a\n  more\n- b\n1. c\n2. d\n- e")).toEqual(["List:-2", "List:1.2", "List:-1"]);
});

// both views of a reply: its HTML, and its terminal lines
const html  = (src: string) => Md.md_parse(src).map(Html.block_html).join("");
const lines = (src: string) => Paint.rows_lines(View.entry_rows(1, "unii", src), 40).map((l) => l.map((r) => r.x).join("").trimEnd());

// the issue's lists: numbers as written, one list across blank lines,
// a sub-list kept under its item; a number in a sentence is no list
test("a numbered list counts as written in both views", () => {
  expect(kinds("1. a\n\n2. b\n\n3. c")).toEqual(["List:1.3"]);
  expect(kinds("1. a\n\n   more\n2. b")).toEqual(["List:1.2"]);
  expect(html("4. d\n5. e")).toContain(`<ol start="4">`);
  expect(html("1. a\n   - sub\n2. b")).toContain("<ul><li>sub");
  expect(kinds("In 2026 we\n2026. was")).toEqual(["Para"]);
  const t = lines("4. d\n   - sub\n5. e");
  expect([t[0], t[2]]).toEqual(["4. d", "5. e"]);
});

// hostile lists once crashed or hung the viewer: each is read
test("a deep or long list is read", () => {
  expect(Md.md_parse(Array.from({ length: 2000 }, (_, k) => " ".repeat(2 * k) + "- x").join("\n")).length).toBe(1);
  expect(Md.md_parse("- ".repeat(10000) + "x").length).toBe(1);
  expect(Md.md_parse("- a" + "\n".repeat(1000000) + "- b").length).toBe(1);
});

// a rule ends the paragraph above it, as a heading or a list does
test("a rule right under a paragraph is a rule", () => {
  expect(kinds("para\n---\nnext")).toEqual(["Para", "Rule", "Para"]);
  expect(kinds("a\n|x|y|\n|-|-|\n|1|2|")).toEqual(["Para", "Tabl"]);
  expect(kinds("a\n| not a table |\nb")).toEqual(["Para"]);
});
