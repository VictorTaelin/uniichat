// Machine test
// ============
// `bun test Machine.test.ts`. The device tools' answers at their edges.

import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import { Machine } from "./Machine.ts";

const DIR = fs.mkdtempSync(os.tmpdir() + "/unii-machine-");

test("a read past a file's end says so, never an empty range", () => {
  const file = DIR + "/three";
  fs.writeFileSync(file, "a\nb\nc\n");
  expect(Machine.read(file, 3, Infinity, 0)).toEqual({ text: "c\n[lines 3-3 of 3]", fail: false });
  expect(Machine.read(file, 9, Infinity, 0)).toEqual({ text: "No lines from line 9: the file has 3.", fail: true });
  expect(Machine.read(file, 2, 0, 0)).toEqual({ text: "No lines from line 2: the file has 3.", fail: true });
});

test("a shell's output is decoded whole: a char split over writes, a broken one at its end", async () => {
  const live = new AbortController().signal;
  const split = await Machine.shell(DIR, "printf 'a\\303'; sleep 0.1; printf '\\251b'", live);
  expect(split.text).toStartWith("aéb\n(exit 0 in ");
  const broken = await Machine.shell(DIR, "printf 'ab\\303'", live);
  expect(broken.text).toStartWith("ab�\n(exit 0 in ");
});

test("without ffmpeg, view_video says how to get it, and read still shows an image", async () => {
  const live = new AbortController().signal;
  const png  = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
  fs.writeFileSync(DIR + "/dot.png", Buffer.from(png, "base64"));
  const path = process.env.PATH;
  process.env.PATH = DIR;
  try {
    const video = await Machine.run({ name: "view_video", input: { path: "clip.mp4" }, cwd: "." }, DIR, live);
    expect(video.fail).toBe(true);
    expect(video.text).toContain("Install ffmpeg");
    const image = await Machine.run({ name: "read", input: { path: "dot.png" }, cwd: "." }, DIR, live);
    expect(image).toEqual({ text: "[image 1x1]", fail: false, imgs: [{ type: "image/png", data: png }] });
  } finally {
    process.env.PATH = path;
  }
});
