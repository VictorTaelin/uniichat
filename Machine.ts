// Machine
// =======
// The tools that touch a device: shell, read, write, edit, view_video
// (TOOLS) and computer (Computer.ts), run by a terminal (Term.ts) as Jobs, each in
// its agent's dir under the device's work dir. A stop kills the job's
// shell and its process group. As this unii quits, end() kills every
// shell's group (SHELLS), and any process marked UNII_RUN that left it.
// A file changed (write over one, edit) answers as a unified diff (Diff),
// which both views draw as one (Md.ts). read shows an image file as an
// image; view_video, frames of a video on one sheet (ffmpeg's).
// This side imports nothing of the server's (whose Config.ts would take
// the user's API keys out of the jobs' environment).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Out } from "./Agent.ts";
import { CAP, clip, clip_end } from "./Clip.ts";
import { Computer } from "./Computer.ts";
import { FIT, IMAGE, image_kind, PIXELS } from "./View.ts";

// Types
// =====

// a tool call to run here: its tool, its input, its agent's dir (a name,
// under the device's work dir)
export type Job = { name: string; input: any; cwd: string };

// a tool as the vendors see it: its name, what it does, its input's
// JSON Schema
export type Spec = { name: string; info: string; schema: object };

// a line of a diff: kept in both texts (" "), only in the old ("-"), only
// in the new ("+")
type Op = { s: " " | "-" | "+"; x: string };

// lines a0 to a1 of an old text, b0 to b1 of a new one (ends excluded)
type Box = [number, number, number, number];

// Constants
// =========

const SHELL = process.env.SHELL ?? "/bin/sh";

// this unii's mark, set as UNII_RUN on every process its shells start
// (each child inherits it), and how to list this user's processes with
// their environment, to find those that left their shell's group
const RUN = crypto.randomUUID();
const UID = String(process.getuid?.() ?? "");
const PS  = process.platform === "darwin" ? ["ps", "-wwE", "-U", UID, "-o", "pid=,command="] : ["ps", "-wwe", "-u", UID, "-o", "pid=,args=", "e"];

// the shells started here, kept until their process groups are empty, so
// end() kills a backgrounded job whose shell already exited
const SHELLS = new Set<Bun.Subprocess>();

// the lines kept around each change in a diff
const CONTEXT = 3;

export const STR = { type: "string" };
export const INT = { type: "integer" };

// the most frames a video sheet takes
const SHEET = 100;

// a video sheet's gap between frames, and around them, in px
const GAP = 4;

// the containers (ffprobe's names) a seek lands exactly in; in others
// (MPEG-TS...) it may land a keyframe late, so they decode from the start
const INDEXED = /\b(mov|mp4|matroska|webm|avi)\b/;

// frames further apart than this, in seconds, are each sought on their
// own, rather than all decoded from the first
const SPARSE = 2;

const EDIT = { type: "object", properties: { path: STR, old: STR, new: STR, all: { type: "boolean" } }, required: ["path", "old", "new"] };

export const TOOLS: Spec[] = [
  spec("shell", "Run a command with the device's shell ($SHELL -c), stdout and stderr together, and return its output, then its exit code and time, as (exit 0 in 0.4 s); output past " + CAP + " characters keeps its head and tail. Each call is a new shell. The call waits until the command and everything holding its output end, so give background jobs their own output file. Background jobs live only while unii is open on the device: closing it kills every process the calls started.", { command: STR }, ["command"]),
  spec("read", "Read a text file. offset: the first line to show (from 1); limit: how many lines; at: the character of the first line to start from. It ends saying the lines shown, as [lines 4-7 of 15]; output past " + CAP + " characters comes in pages, saying where to go on. An image file (png, jpeg, gif, webp) comes as the picture, scaled to fit " + FIT + " px, or max_side px if given (a GIF shows its first frame; view_video plays it).", { path: STR, offset: INT, limit: INT, at: INT, max_side: INT }, ["path"]),
  spec("write", "Write a whole file, making its directories. Answers a unified diff of what changed (a new file: all its lines added).", { path: STR, content: STR }, ["path", "content"]),
  spec("view_video", "See part of a video (any file ffmpeg opens: mp4, mkv, webm, mov, avi, gif...) as ONE image: a grid of its frames, row by row, each stamped with its frame number (top) and time (bottom), fitting " + FIT + " px, or max_side px. It also answers a line on the whole video (duration, fps, frames, size). start and end: the range, ends included, in frames from 0 (or seconds, with unit \"second\"); by default the whole video. step: take every step-th frame; by default the one that gives at most 16. Each frame gets smaller as more share the sheet: past about 25 they get hard to read, and " + SHEET + " is the most. For a long stretch, raise step, narrow the range, or call again on the next range. Needs ffmpeg and ffprobe on the device.", { path: STR, start: { type: "number" }, end: { type: "number" }, unit: { type: "string", enum: ["frame", "second"] }, step: INT, max_side: INT }, ["path"]),
  spec("edit", "Replace text in files: the edits in order, each on its file as the edits before it left it. old must match exactly, whitespace included, and only once, unless all is true, which replaces every match. If any edit fails, no file is changed. Answers a unified diff of each file.", { edits: { type: "array", items: EDIT, minItems: 1 } }, ["edits"]),
];

// the tool of a computer task, bound to its device: Anthropic's computer
// use tool, its actions and fields as theirs (so the model does as it
// was trained); one tool for every vendor, as every tool is
const PX = { type: "array", items: { type: "integer" }, minItems: 2, maxItems: 2 };

// the longest wait or hold_key, in seconds (Computer.ts clamps to it)
export const WAIT = 100;
export const COMPUTER: Spec = spec("computer", `Use a mouse and keyboard to interact with the user's Mac, and take screenshots. Every action answers with a screenshot taken after it.
* This is an interface to a desktop GUI. Some applications may take time to start or process actions, so you may need to wait and take successive screenshots to see the results of your actions. E.g. if you click on Safari and a window doesn't open, try waiting and taking another screenshot.
* Coordinates are pixels of the screenshot (1280x800 at most), x from its left edge, y from its top edge.
* Whenever you intend to move the cursor to click on an element like an icon, you should consult a screenshot to determine the coordinates of the element before moving the cursor.
* If you tried clicking on a program or link but it failed to load, even after waiting, try adjusting your cursor position so that the tip of the cursor visually falls on the element that you want to click.
* Make sure to click any buttons, links, icons, etc with the cursor tip in the center of the element. Don't click boxes on their edges unless asked.`, {
  action: { type: "string", enum: ["key", "hold_key", "type", "cursor_position", "mouse_move", "left_mouse_down", "left_mouse_up", "left_click", "left_click_drag", "right_click", "middle_click", "double_click", "triple_click", "scroll", "wait", "screenshot", "zoom"], description: `The action to perform. The available actions are:
* \`key\`: Press a key or key-combination on the keyboard. This supports xdotool's \`key\` syntax. Examples: "a", "Return", "cmd+l", "ctrl+s", "Up".
* \`hold_key\`: Hold down a key or multiple keys for a specified duration (in seconds). Supports the same syntax as \`key\`.
* \`type\`: Type a string of text on the keyboard.
* \`cursor_position\`: Get the current (x, y) pixel coordinate of the cursor on the screen.
* \`mouse_move\`: Move the cursor to a specified (x, y) pixel coordinate on the screen.
* \`left_mouse_down\`: Press the left mouse button.
* \`left_mouse_up\`: Release the left mouse button.
* \`left_click\`: Click the left mouse button at the specified (x, y) pixel coordinate on the screen. You can also include a key combination to hold down while clicking using the \`text\` parameter.
* \`left_click_drag\`: Click and drag the cursor from \`start_coordinate\` to a specified (x, y) pixel coordinate on the screen.
* \`right_click\`: Click the right mouse button at the specified (x, y) pixel coordinate on the screen.
* \`middle_click\`: Click the middle mouse button at the specified (x, y) pixel coordinate on the screen.
* \`double_click\`: Double-click the left mouse button at the specified (x, y) pixel coordinate on the screen.
* \`triple_click\`: Triple-click the left mouse button at the specified (x, y) pixel coordinate on the screen.
* \`scroll\`: Scroll the screen in a specified direction by a specified amount of clicks of the scroll wheel, at the specified (x, y) pixel coordinate. DO NOT use PageUp/PageDown to scroll.
* \`wait\`: Wait for a specified duration (in seconds).
* \`screenshot\`: Take a screenshot of the screen.
* \`zoom\`: View a region of the screen at full resolution.` },
  coordinate       : { ...PX, description: "(x, y): The x (pixels from the left edge) and y (pixels from the top edge) coordinates to move the mouse to. Required by `action=mouse_move` and `action=left_click_drag`; optional for clicks and `scroll` (default: where the cursor is)." },
  start_coordinate : { ...PX, description: "(x, y): The x (pixels from the left edge) and y (pixels from the top edge) coordinates to start the drag from. Required only by `action=left_click_drag`." },
  text             : { type: "string", description: "Required only by `action=type`, `action=key`, and `action=hold_key`. Can also be used by click or scroll actions to hold down keys while clicking or scrolling." },
  scroll_direction : { type: "string", enum: ["up", "down", "left", "right"], description: "The direction to scroll the screen. Required only by `action=scroll`." },
  scroll_amount    : { type: "integer", minimum: 0, description: "The number of 'clicks' to scroll. Required only by `action=scroll`." },
  duration         : { type: "number", minimum: 0, maximum: WAIT, description: "The duration to hold the key down for, or to wait, in seconds. Required only by `action=hold_key` and `action=wait`." },
  region           : { type: "array", items: { type: "integer" }, minItems: 4, maxItems: 4, description: "(x0, y0, x1, y1): The top-left and bottom-right corners of the region to view. Required only by `action=zoom`." },
}, ["action"]);

// Spec
// ====

// a tool whose input is an object of these fields, the `need` ones
// required
export function spec(name: string, info: string, fields: object, need: string[]): Spec {
  const schema = { type: "object", properties: fields, required: need };
  return { name, info, schema };
}

// Machine
// =======

export namespace Machine {

  export async function run(job: Job, work: string, signal: AbortSignal): Promise<Out> {
    const root = work.startsWith("~/") ? os.homedir() + work.slice(1) : work;
    const cwd = path.join(root, path.basename(job.cwd));
    const input = job.input;
    const file = path.resolve(cwd, String(input.path));
    try {
      fs.mkdirSync(cwd, { recursive: true });
      switch (job.name) {
        case "shell": {
          return await Machine.shell(cwd, String(input.command), signal);
        }
        case "read": {
          const data = fs.readFileSync(file);
          const kind = image_kind(data);
          if (kind !== null) {
            return await Machine.image(data, kind, Machine.side(input.max_side));
          }
          return Machine.read(file, Number(input.offset ?? 1), Number(input.limit ?? Infinity), Number(input.at ?? 0));
        }
        case "view_video": {
          return await Machine.video(file, input, signal);
        }
        case "write": {
          return Machine.write(file, String(input.path), String(input.content));
        }
        case "edit": {
          return Machine.edit(cwd, input.edits);
        }
        case "computer": {
          return await Computer.act(input, signal);
        }
        default: {
          return { text: "No tool " + job.name + ".", fail: true };
        }
      }
    } catch (err: any) {
      return { text: String(err?.message ?? err), fail: true };
    }
  }

  // runs a command, in its own process group (detached), every process
  // marked UNII_RUN, its output decoded as one stream (a char split over
  // reads stays whole; a broken one at its end shows) and cut as it
  // comes. A stop kills the group and ends the wait at once, whatever
  // still holds its output
  export async function shell(cwd: string, command: string, signal: AbortSignal): Promise<Out> {
    SHELLS.forEach((p) => Machine.group(p) || SHELLS.delete(p));
    const start = performance.now();
    const proc = Bun.spawn([SHELL, "-c", "exec 2>&1\n" + command], {
      cwd      : cwd,
      env      : { ...process.env, UNII_RUN: RUN },
      stdin    : "ignore",
      stdout   : "pipe",
      stderr   : "ignore",
      detached : true,
    });
    const out = clip();
    SHELLS.add(proc);
    const reader = proc.stdout.pipeThrough(new TextDecoderStream()).getReader();
    const kill = () => {
      Machine.kill(-proc.pid);
      reader.cancel().catch(() => {});
    };
    signal.addEventListener("abort", kill, { once: true });
    try {
      for (let got = await reader.read(); !got.done; got = await reader.read()) {
        out.add(got.value);
      }
    } catch {}
    signal.removeEventListener("abort", kill);
    const code = await proc.exited;
    const time = ((performance.now() - start) / 1000).toFixed(1) + " s";
    const exit = signal.aborted ? "stopped" : proc.signalCode ? "killed by " + proc.signalCode : "exit " + code;
    const text = out.text().replace(/\n$/, "");
    return { text: (text === "" ? "" : text + "\n") + "(" + exit + " in " + time + ")", fail: exit !== "exit 0" };
  }

  // whether a shell's process group may still hold a job: the shell runs,
  // or it is gone but its id names no live process and its group still
  // has one
  export function group(proc: Bun.Subprocess): boolean {
    const ended = proc.exitCode !== null || proc.signalCode !== null;
    return !ended || (!Machine.alive(proc.pid) && Machine.alive(-proc.pid));
  }

  // whether a process (pid) or a process group (-pid) exists
  export function alive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err: any) {
      return err.code === "EPERM";
    }
  }

  export function kill(pid: number): void {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }

  // as this unii quits: kills every shell's process group (a job still in
  // it dies), then any process that left its group (UNII_RUN), so none is
  // left orphaned
  export function end(): void {
    for (const proc of SHELLS) {
      if (Machine.group(proc)) {
        Machine.kill(-proc.pid);
      }
    }
    const ps = Bun.spawnSync(PS).stdout.toString();
    for (const line of ps.split("\n")) {
      if (line.includes("UNII_RUN=" + RUN)) {
        Machine.kill(Number(line.trim().split(" ")[0]));
      }
    }
  }

  // `limit` lines from line `offset`, from its character `at`: a page of
  // them (Clip.ts), and past it where to go on; failed if there are none
  export function read(file: string, offset: number, limit: number, at: number): Out {
    const data = fs.readFileSync(file);
    if (data.includes(0)) {
      return { text: "A binary file of " + data.length + " bytes.", fail: true };
    }
    const lines = data.toString("utf8").replace(/\n$/, "").split("\n");
    const from  = Math.max(1, offset);
    const rows  = lines.slice(from - 1, from - 1 + limit);
    if (rows.length === 0) {
      return { text: "No lines from line " + from + ": the file has " + lines.length + ".", fail: true };
    }
    const text  = rows.join("\n");
    const end   = clip_end(text, at);
    const whole = end === text.length;
    const head  = text.slice(0, end).split("\n");
    const next  = from + head.length - 1;
    const col   = head[head.length - 1].length;
    const last  = whole ? from + rows.length - 1 : col === 0 ? next - 1 : next;
    const go    = whole ? "" : "; go on with offset " + next + (col === 0 ? "" : ", at " + col);
    const shown = "\n[lines " + from + "-" + last + " of " + lines.length + go + "]";
    return { text: text.slice(at, end).replace(/\n$/, "") + shown, fail: false };
  }

  // the longest side an image goes at: max_side, if given, up to FIT
  export function side(max: unknown): number {
    const n = Math.floor(Number(max));
    return n >= 1 && n < FIT ? n : FIT;
  }

  // an image file as models get it: as is, if no larger than side and of
  // IMAGE bytes at most; else scaled to fit side, as a JPEG (a JPEG's) or
  // a WebP (which keeps any transparency)
  export async function image(data: Buffer, kind: string, side: number): Promise<Out> {
    const img  = new Bun.Image(data);
    const size = await img.metadata().catch(() => null);
    if (size === null) {
      return { text: "Not a readable " + kind + " (" + data.length + " bytes).", fail: true };
    }
    const { width: w0, height: h0 } = size;
    if (w0 * h0 > PIXELS) {
      return { text: "An image of " + w0 + "x" + h0 + ": too many pixels to open.", fail: true };
    }
    const k = Math.min(1, side / Math.max(w0, h0));
    if (k === 1 && data.length <= IMAGE) {
      return { text: "[image " + w0 + "x" + h0 + "]", fail: false, imgs: [{ type: kind, data: data.toString("base64") }] };
    }
    const [w, h] = [Math.max(1, Math.round(w0 * k)), Math.max(1, Math.round(h0 * k))];
    const fit  = img.resize(w, h);
    const jpeg = kind === "image/jpeg";
    const out  = await (jpeg ? fit.jpeg({ quality: 85 }) : fit.webp({ quality: 85 })).bytes();
    const type = jpeg ? "image/jpeg" : "image/webp";
    return { text: "[image " + w + "x" + h + ", scaled from " + w0 + "x" + h0 + "]", fail: false, imgs: [{ type, data: Buffer.from(out).toString("base64") }] };
  }

  // frames of a video (input: view_video's) on one sheet, as ffmpeg makes
  // it, with a line on the whole video from ffprobe. The frames taken are
  // start, start + step... up to end (frame numbers; seconds turn into
  // them at the video's frame rate). ffmpeg seeks to start (half a frame
  // early, so it lands on it; each frame stamped with its time from the
  // file's start), where the container lets it (INDEXED), and decodes on
  // the CPU: a few frames a call, the same
  // on every machine
  export async function video(file: string, input: any, signal: AbortSignal): Promise<Out> {
    if (["ffmpeg", "ffprobe"].some((bin) => Bun.which(bin, { PATH: process.env.PATH ?? "" }) === null)) {
      return { text: "view_video needs ffmpeg and ffprobe, which aren't installed on this device. Install ffmpeg (e.g. apt install ffmpeg / brew install ffmpeg / winget install ffmpeg) and try again.", fail: true };
    }
    const shown = ["stream=codec_name,width,height,avg_frame_rate,r_frame_rate,nb_frames,duration", "format=duration,format_name"].join(":");
    const probe = await Machine.exec(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", shown, "-of", "json", file], signal);
    if (probe.code !== 0) {
      return { text: "ffprobe: " + probe.err.trim(), fail: true };
    }
    const json   = JSON.parse(probe.out.toString());
    const stream = json.streams?.[0];
    if (stream === undefined) {
      return { text: "No video stream in " + input.path + ".", fail: true };
    }
    const fps    = Machine.rate(stream.avg_frame_rate) || Machine.rate(stream.r_frame_rate);
    const secs   = Number(stream.duration ?? json.format?.duration);
    const exact  = Number(stream.nb_frames) > 0;
    const frames = exact ? Number(stream.nb_frames) : Math.round(secs * fps);
    const total  = frames > 0 ? (exact ? "" : "about ") + frames + " frames (0-" + (frames - 1) + ")" : "frame count unknown";
    const [w0, h0] = [Number(stream.width), Number(stream.height)];
    const about  = input.path + ": " + (secs > 0 ? +secs.toFixed(3) + " s, " : "") + +fps.toFixed(3) + " fps, " + total + ", " + w0 + "x" + h0 + ", " + stream.codec_name;
    const sec    = input.unit === "second";
    if (sec && !(fps > 0)) {
      return { text: about + "\nIts frame rate is unknown: give start and end in frames.", fail: true };
    }
    const at     = (x: unknown, or: number) => (x === undefined || x === null ? or : Math.round(Number(x) * (sec ? fps : 1)));
    const start  = at(input.start, 0);
    const last   = frames > 0 ? frames - 1 : start + 15 * (Number(input.step) || 1);
    const end    = Math.min(at(input.end, last), exact ? frames - 1 : Infinity);
    const step   = input.step === undefined || input.step === null ? Math.max(1, Math.ceil((end - start + 1) / 16)) : Math.floor(Number(input.step));
    const why    = !(start >= 0) ? "start must be 0 or more" : !(start < frames || !exact) ? "start is past the last frame" : !(end >= start) ? "end must not be before start" : !(step >= 1) ? "step must be 1 or more" : "";
    if (why !== "") {
      return { text: about + "\n" + why + ".", fail: true };
    }
    const count = Math.floor((end - start) / step) + 1;
    if (count > SHEET) {
      return { text: about + "\n" + count + " frames: at most " + SHEET + " fit one sheet. Raise step, narrow the range, or call again on consecutive ranges.", fail: true };
    }
    const side  = Machine.side(input.max_side);
    const fits  = (c: number) => Math.min((side - GAP * (c + 1)) / (c * w0), (side - GAP * (Math.ceil(count / c) + 1)) / (Math.ceil(count / c) * h0));
    let cols    = 1;
    for (let c = 2; c <= count; c++) {
      cols = fits(c) > fits(cols) ? c : cols;
    }
    const rows  = Math.ceil(count / cols);
    const k     = Math.min(1, fits(cols));
    const [w, h] = [Math.max(2, 2 * Math.floor((w0 * k) / 2)), Math.max(2, 2 * Math.floor((h0 * k) / 2))];
    const font  = Math.max(10, Math.round(Math.min(h / 10, w / 8)));
    const label = ":fontsize=" + font + ":fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=2:x=2";
    const seeks = fps > 0 && INDEXED.test(json.format?.format_name ?? "");
    const pick  = (f: number) => (seeks && f > 0 ? ["-ss", String((f - 0.5) / fps)] : []);
    const ffmpeg = (from: string[], input: string, graph: string, stdin?: Buffer) => Machine.exec(["ffmpeg", "-v", "error", ...from, "-i", input, "-an", "-sn", "-dn", "-vf", graph, "-frames:v", "1", "-f", "image2pipe", "-c:v", "mjpeg", "-q:v", "3", "pipe:1"], signal, stdin);
    const grid  = "tile=" + cols + "x" + rows + ":padding=" + GAP + ":margin=" + GAP + ":color=white";
    // its frames stamped (or not: an ffmpeg without drawtext), number n
    // (an expression) and time; past SPARSE s apart, each sought on its
    // own, then tiled; else all from one seek to start
    const sheet = async (stamp: boolean) => {
      const marks = (n: string, from: string[]) => (stamp ? ",drawtext=text='" + n + "'" + label + ":y=2,drawtext=text='%{pts\\:hms\\:" + (from[1] ?? 0) + "}'" + label + ":y=h-th-4" : "");
      if (seeks && step / fps > SPARSE) {
        const shots: Buffer[] = [];
        for (let f = start; f <= end; f += step) {
          const one = await ffmpeg(pick(f), file, "scale=" + w + ":" + h + marks(String(f), pick(f)));
          if (one.code !== 0) {
            return one;
          }
          shots.push(one.out);
        }
        return ffmpeg(["-f", "image2pipe", "-c:v", "mjpeg"], "pipe:0", grid, Buffer.concat(shots));
      }
      const first = seeks ? 0 : start;
      const which = "select='between(n," + first + "," + (end - start + first) + ")*not(mod(n-" + first + "," + step + "))'";
      return ffmpeg(pick(start), file, which + ",scale=" + w + ":" + h + marks("%{eif\\:n*" + step + "+" + start + "\\:d}", pick(start)) + "," + grid);
    };
    let made    = await sheet(true);
    let note    = "";
    if (made.code !== 0 && /drawtext|font/i.test(made.err)) {
      made = await sheet(false);
      note = " (unstamped: this ffmpeg can't draw text)";
    }
    if (made.code !== 0 || made.out.length === 0) {
      return { text: about + "\nffmpeg: " + (made.err.trim() || "no frame in that range"), fail: true };
    }
    const range = "frames " + start + "-" + (start + (count - 1) * step) + (step > 1 ? " every " + step : "");
    const text  = about + "\nSheet: " + range + ", " + count + " frames in " + cols + "x" + rows + ", row by row" + note + ".";
    return { text, fail: false, imgs: [{ type: "image/jpeg", data: made.out.toString("base64") }] };
  }

  // a frame rate as ffprobe gives it ("30000/1001"); 0 if none
  export function rate(text: unknown): number {
    const [a, b = 1] = String(text).split("/").map(Number);
    return a > 0 && b > 0 ? a / b : 0;
  }

  // a program's output, its errors, its exit code; killed on a stop
  export async function exec(argv: string[], signal: AbortSignal, stdin?: Buffer): Promise<{ out: Buffer; err: string; code: number }> {
    const proc = Bun.spawn(argv, { stdin: stdin ?? "ignore", stdout: "pipe", stderr: "pipe", signal });
    const [out, err] = await Promise.all([new Response(proc.stdout).arrayBuffer(), new Response(proc.stderr).text()]);
    return { out: Buffer.from(out), err, code: await proc.exited };
  }

  // a file (named as given: shown) written whole: its diff (a new one's,
  // all its lines added), so a write reads as an edit
  export function write(file: string, shown: string, content: string): Out {
    const was = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return { text: text_diff(shown, was, content), fail: false };
  }

  // the edits, in order, each on its file as the ones before left it;
  // every file is written only once all of them apply, so a failed one
  // changes none. Each file, named as its first edit gives it, answers
  // its diff
  export function edit(cwd: string, edits: unknown): Out {
    const list  = Array.isArray(edits) ? edits : [];
    const files = new Map<string, { shown: string; was: string; text: string }>();
    for (const [k, e] of list.entries()) {
      const file  = path.resolve(cwd, String(e?.path));
      const known = files.get(file);
      const was   = known?.was ?? (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null);
      const text  = known?.text ?? was ?? "";
      const old   = String(e?.old ?? "");
      const count = old === "" ? 0 : text.split(old).length - 1;
      const why   = was === null ? "no such file" : count === 0 ? "old was not found" : count > 1 && e.all !== true ? "old matches " + count + " times; give more context, or all" : "";
      if (why !== "") {
        return { text: "Edit " + (k + 1) + " (" + e?.path + "): " + why + ". No file was changed.", fail: true };
      }
      files.set(file, { shown: known?.shown ?? String(e.path), was: was!, text: text.split(old).join(String(e.new)) });
    }
    if (files.size === 0) {
      return { text: "edits is empty: give a list of {path, old, new}.", fail: true };
    }
    for (const [file, f] of files) {
      fs.writeFileSync(file, f.text);
    }
    const diffs = [...files.values()].map((f) => text_diff(f.shown, f.was, f.text));
    return { text: diffs.join("\n"), fail: false };
  }

  // ms, or till the signal aborts: none, if it already did (an abort
  // event comes once)
  export function nap(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((ok) => {
      const timer = setTimeout(ok, signal.aborted ? 0 : ms);
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        ok();
      });
    });
  }

}

// Diff
// ====

// a file's change as a unified diff: its name as old and new file, then
// each run of changes in a hunk with CONTEXT lines around it (runs that
// close share one), clipped as a command's output. Lines keep their "\n",
// so a last one without it differs, and says so as git does
function text_diff(file: string, was: string, now: string): string {
  const [a, b] = [text_lines(was), text_lines(now)];
  const ops = lines_diff(a, b);
  const at  : [number, number][] = [];
  let [i, j] = [0, 0];
  for (const op of ops) {
    at.push([i, j]);
    i += op.s === "+" ? 0 : 1;
    j += op.s === "-" ? 0 : 1;
  }
  const keys  = ops.flatMap((op, k) => (op.s === " " ? [] : [k]));
  const hunks : [number, number][] = [];
  for (const k of keys) {
    const top = hunks[hunks.length - 1];
    if (top !== undefined && k - top[1] <= 2 * CONTEXT) {
      top[1] = k + 1;
    } else {
      hunks.push([k, k + 1]);
    }
  }
  if (hunks.length === 0) {
    return file + " is unchanged.";
  }
  const out = clip();
  out.add("--- " + file + "\n+++ " + file);
  for (const [lo, hi] of hunks) {
    const a    = Math.max(0, lo - CONTEXT);
    const b    = Math.min(ops.length, hi + CONTEXT);
    const run  = ops.slice(a, b);
    const olds = run.filter((op) => op.s !== "+").length;
    const news = run.filter((op) => op.s !== "-").length;
    const head = "@@ -" + (at[a][0] + (olds === 0 ? 0 : 1)) + "," + olds + " +" + (at[a][1] + (news === 0 ? 0 : 1)) + "," + news + " @@";
    out.add("\n" + head + run.map((op) => "\n" + op.s + op.x.replace(/\n$/, "")).join(""));
  }
  return out.text();
}

// the shortest script from lines a to lines b: their lines kept (the
// most, lines_match), and in each gap between two the old lines
// dropped, then the new added, as git shows them. A line only one text
// has is never kept, so the match runs without them (a file rewritten
// whole needs no search)
function lines_diff(a: string[], b: string[]): Op[] {
  const [in_a, in_b] = [new Set(a), new Set(b)];
  const ia    = a.flatMap((x, i) => (in_b.has(x) ? [i] : []));
  const ib    = b.flatMap((x, j) => (in_a.has(x) ? [j] : []));
  const pairs = lines_match(ia.map((i) => a[i]), ib.map((j) => b[j]), [0, ia.length, 0, ib.length], []);
  const ops   : Op[] = [];
  let [i, j] = [0, 0];
  for (const [p, q] of pairs) {
    ops_push(ops, "-", a, i, ia[p]);
    ops_push(ops, "+", b, j, ib[q]);
    ops.push({ s: " ", x: a[ia[p]] });
    [i, j] = [ia[p] + 1, ib[q] + 1];
  }
  ops_push(ops, "-", a, i, a.length);
  return ops_push(ops, "+", b, j, b.length);
}

// lines i to j of xs, each as an op of mark s
function ops_push(ops: Op[], s: Op["s"], xs: string[], i: number, j: number): Op[] {
  for (let k = i; k < j; k++) {
    ops.push({ s, x: xs[k] });
  }
  return ops;
}

// the lines of a and b kept in a box of them, as their pairs [i, j]
// pushed in order: a longest common subsequence (Myers, in linear space):
// the common head and tail; between them, unless a side is empty, the
// middle snake (box_snake), and each part around it done alike. Time
// (n+m)·d, d the lines changed
function lines_match(a: string[], b: string[], box: Box, pairs: [number, number][]): [number, number][] {
  let [a0, a1, b0, b1] = box;
  let tail = 0;
  for (; a0 < a1 && b0 < b1 && a[a0] === b[b0]; a0++, b0++) {
    pairs.push([a0, b0]);
  }
  for (; a0 < a1 && b0 < b1 && a[a1 - 1] === b[b1 - 1]; a1--, b1--) {
    tail++;
  }
  if (a0 < a1 && b0 < b1) {
    const [x, u, y, v] = box_snake(a, b, [a0, a1, b0, b1]);
    lines_match(a, b, [a0, x, b0, y], pairs);
    for (let k = 0; k < u - x; k++) {
      pairs.push([x + k, y + k]);
    }
    lines_match(a, b, [u, a1, v, b1], pairs);
  }
  for (let k = 0; k < tail; k++) {
    pairs.push([a1 + k, b1 + k]);
  }
  return pairs;
}

// a text's lines, each with its "\n" (the last may lack it), and the
// "\ No newline at end of file" git puts after such a line in a diff
function text_lines(text: string): string[] {
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  return lines.map((l) => (l.endsWith("\n") ? l : l + "\n\\ No newline at end of file"));
}

// a box's middle snake, as the box it spans: where a shortest path from
// its top corner meets one from its bottom, both grown a step d at a
// time, each keeping the furthest x reached on each diagonal k = x - y
// (vf from the top, vb from the bottom, counted back)
function box_snake(a: string[], b: string[], [a0, a1, b0, b1]: Box): Box {
  const [n, m] = [a1 - a0, b1 - b0];
  const delta = n - m;
  const off   = n + m + 1;
  const vf    = new Int32Array(2 * off + 1);
  const vb    = new Int32Array(2 * off + 1);
  for (let d = 0; ; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && vf[off + k - 1] < vf[off + k + 1]) ? vf[off + k + 1] : vf[off + k - 1] + 1;
      const x0 = x;
      while (x < n && x - k < m && a[a0 + x] === b[b0 + x - k]) {
        x++;
      }
      vf[off + k] = x;
      const c = delta - k;
      if (delta % 2 !== 0 && Math.abs(c) < d && x + vb[off + c] >= n) {
        return [a0 + x0, a0 + x, b0 + x0 - k, b0 + x - k];
      }
    }
    for (let c = -d; c <= d; c += 2) {
      let x = c === -d || (c !== d && vb[off + c - 1] < vb[off + c + 1]) ? vb[off + c + 1] : vb[off + c - 1] + 1;
      const x0 = x;
      while (x < n && x - c < m && a[a1 - 1 - x] === b[b1 - 1 - x + c]) {
        x++;
      }
      vb[off + c] = x;
      const k = delta - c;
      if (delta % 2 === 0 && Math.abs(k) <= d && x + vf[off + k] >= n) {
        return [a1 - x, a1 - x0, b1 - x + c, b1 - x0 + c];
      }
    }
  }
}
