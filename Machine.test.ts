// Machine test
// ============
// `bun test Machine.test.ts`. The device tools' answers at their edges.

import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import { Machine } from "./Machine.ts";
import { FRAME } from "./View.ts";

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

test("read shows only what decodes as an image: a text file that starts like one reads as text, a GIF as its first frame", async () => {
  const live = new AbortController().signal;
  const read = (file: string) => Machine.run({ name: "read", input: { path: file }, cwd: "." }, DIR, live);
  fs.writeFileSync(DIR + "/note.txt", "GIF89a starts this note\n");
  expect(await read("note.txt")).toEqual({ text: "GIF89a starts this note\n[lines 1-1 of 1]", fail: false });
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64");
  fs.writeFileSync(DIR + "/head.png", png.subarray(0, 33));
  expect((await read("head.png")).fail).toBe(true);
  const gif = Buffer.from("R0lGODlhAQABAIAAAP///wAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQEAAAAACwAAAAAAQABAAACAkQBACH5BAQAAAAALAAAAAABAAEAAAICRAEAOw==", "base64");
  fs.writeFileSync(DIR + "/two.gif", gif);
  const still = await read("two.gif");
  expect(still.imgs?.length).toBe(1);
  expect(still.imgs![0].type).not.toBe("image/gif");
});

// frame n of a test video is grey 16 + 4n, at a time that isn't n / fps
test.skipIf(Bun.which("ffmpeg") === null)("view_video takes the frames asked for, by number, in a variable frame rate and past the end", async () => {
  const live = new AbortController().signal;
  const make = ["-v", "error", "-f", "lavfi", "-i", "color=black:s=160x120:r=30:d=1,geq=lum='16+N*4':cb=128:cr=128", "-vf", "setpts='(N*N*0.002+N*0.02)/TB'", "-fps_mode", "vfr", "-c:v", "libx264", "-crf", "5", "-pix_fmt", "yuv420p"];
  Bun.spawnSync(["ffmpeg", ...make, DIR + "/vfr.mp4"]);
  Bun.spawnSync(["ffmpeg", ...make.slice(0, -6), "-c:v", "libvpx", "-f", "webm", DIR + "/vfr.webm"]);
  const grey = (sheet: string, x: number, y: number) => {
    fs.writeFileSync(DIR + "/sheet.jpg", Buffer.from(sheet, "base64"));
    const px = Bun.spawnSync(["ffmpeg", "-v", "error", "-i", DIR + "/sheet.jpg", "-vf", `format=gray,crop=2:2:${x}:${y}`, "-f", "rawvideo", "-"]).stdout;
    return Math.round((px[0] * 219) / 255 / 4);
  };
  for (const [path, input] of [["vfr.mp4", { start: 15, end: 15 }], ["vfr.mp4", { start: 0.9, end: 0.9, unit: "second" }], ["vfr.webm", { start: 20, end: 20 }]] as const) {
    const out = await Machine.run({ name: "view_video", input: { path, ...input }, cwd: "." }, DIR, live);
    const want = "unit" in input ? 17 : input.start;
    expect(out.text).toContain("frames " + want + "-" + want + ",");
    expect(grey(out.imgs![0].data, 84, 64)).toBe(want);
  }
  const past = await Machine.run({ name: "view_video", input: { path: "vfr.webm", start: 28, end: 40 }, cwd: "." }, DIR, live);
  expect(past.text).toContain("frames 28-29, 2 frames");
  const none = await Machine.run({ name: "view_video", input: { path: "vfr.webm", start: 40 }, cwd: "." }, DIR, live);
  expect(none.fail).toBe(true);
});

test.skipIf(Bun.which("ffmpeg") === null)("a noisy image with transparency still fits a terminal's message", async () => {
  Bun.spawnSync(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "nullsrc=s=1568x1568,geq=r='random(1)*255':g='random(2)*255':b='random(3)*255':a='random(4)*255',format=rgba", "-frames:v", "1", DIR + "/noise.png"]);
  const out = await Machine.run({ name: "read", input: { path: "noise.png" }, cwd: "." }, DIR, new AbortController().signal);
  expect(out.imgs?.length).toBe(1);
  expect(Buffer.byteLength(JSON.stringify(out))).toBeLessThan(FRAME - 1024);
});
