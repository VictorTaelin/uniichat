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
import { FIT, HEAD, IMAGE, image_kind, PIXELS } from "./View.ts";

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

// the packets read past a range's end: a frame shows after those decoded
// before it, at most this many later
const REORDER = 16;

// the smallest side of a frame on a sheet, in px
const CELL = 16;

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
          const kind = image_kind(Machine.head(file));
          const data = kind === null ? null : fs.readFileSync(file);
          const shown = data === null ? null : await Machine.image(data, kind!, Machine.side(input.max_side));
          if (shown !== null) {
            return shown;
          }
          if (data?.includes(0)) {
            return { text: "Not a readable " + kind + " (" + data.length + " bytes).", fail: true };
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

  // a file's first HEAD bytes
  export function head(file: string): Buffer {
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(HEAD);
      return buf.subarray(0, fs.readSync(fd, buf, 0, HEAD, 0));
    } finally {
      fs.closeSync(fd);
    }
  }

  // the longest side an image goes at: max_side, if given, up to FIT
  export function side(max: unknown): number {
    const n = Math.floor(Number(max));
    return n >= 1 && n < FIT ? n : FIT;
  }

  // an image file as models get it, decoded (null: it isn't, as its
  // header said): as is, if no larger than side, of IMAGE bytes at most
  // and no GIF (an animated one goes as its first frame); else fit to
  // side, as a PNG or WebP (a JPEG's as a JPEG), then as a JPEG, smaller
  // each time, till it takes IMAGE bytes at most
  export async function image(data: Buffer, kind: string, side: number): Promise<Out | null> {
    const size = await new Bun.Image(data).metadata().catch(() => null);
    if (size === null) {
      return null;
    }
    const { width: w0, height: h0 } = size;
    if (w0 * h0 > PIXELS) {
      return { text: "An image of " + w0 + "x" + h0 + ": too many pixels to open.", fail: true };
    }
    const k = Math.min(1, side / Math.max(w0, h0));
    const kinds = kind === "image/jpeg" ? ["jpeg"] : ["png", "webp", "jpeg"];
    for (let [w, h] = [Math.max(1, Math.round(w0 * k)), Math.max(1, Math.round(h0 * k))]; ; [w, h] = [Math.max(1, Math.round(w * 0.75)), Math.max(1, Math.round(h * 0.75))]) {
      for (const as of kinds) {
        const fit = new Bun.Image(data).resize(w, h);
        const out = await (as === "png" ? fit.png() : as === "webp" ? fit.webp({ quality: 85 }) : fit.jpeg({ quality: 85 })).bytes().catch(() => null);
        if (out === null) {
          return null;
        }
        if (k === 1 && w === w0 && kind !== "image/gif" && data.length <= IMAGE) {
          return { text: "[image " + w0 + "x" + h0 + "]", fail: false, imgs: [{ type: kind, data: data.toString("base64") }] };
        }
        if (out.length <= IMAGE || w * h <= 64) {
          const how = w === w0 && h === h0 ? "" : ", scaled from " + w0 + "x" + h0;
          return { text: "[image " + w + "x" + h + how + "]", fail: false, imgs: [{ type: "image/" + as, data: Buffer.from(out).toString("base64") }] };
        }
      }
    }
  }

  // frames of a video (input: view_video's) on one sheet, as ffmpeg makes
  // it, with a line on the whole video from ffprobe. The frames taken are
  // start, start + step... up to end, by number (seconds: the frames in
  // them). Each frame's time comes from its packet's (ffprobe), read up to
  // end, so a frame's number holds in a variable frame rate too. ffmpeg
  // seeks to start (between it and the frame before), where the container
  // lets it (INDEXED), else it decodes from the file's start; one seek per
  // frame if they are SPARSE apart. It decodes on the CPU: a few frames a
  // call, the same on every machine
  export async function video(file: string, input: any, signal: AbortSignal): Promise<Out> {
    const [ffmpeg, ffprobe] = ["ffmpeg", "ffprobe"].map((bin) => Bun.which(bin, { PATH: process.env.PATH ?? "" }));
    if (ffmpeg === null || ffprobe === null) {
      return { text: "view_video needs ffmpeg and ffprobe, which aren't installed on this device. Install ffmpeg (e.g. apt install ffmpeg / brew install ffmpeg / winget install ffmpeg) and try again.", fail: true };
    }
    const shown = "stream=index,codec_name,width,height,sample_aspect_ratio,avg_frame_rate,r_frame_rate,nb_frames,duration:stream_side_data=rotation:format=duration,format_name,start_time";
    const probe = await Machine.exec([ffprobe, "-v", "error", "-select_streams", "V:0", "-show_entries", shown, "-of", "json", file], signal);
    if (probe.code !== 0) {
      return { text: "ffprobe: " + probe.err.trim(), fail: true };
    }
    const json   = JSON.parse(probe.out.toString());
    const stream = json.streams?.[0];
    if (!(stream?.width > 0 && stream.height > 0)) {
      return { text: "No video stream in " + input.path + ".", fail: true };
    }
    const sec    = input.unit === "second";
    const given  = (x: unknown) => x !== undefined && x !== null;
    const [s0, s1] = [given(input.start) ? Number(input.start) : 0, given(input.end) ? Number(input.end) : Infinity];
    // the frames' times, from the file's start, in order: up to the
    // range's end (and REORDER packets past it), or all (whole)
    const upto   = s1 === Infinity ? [] : ["-read_intervals", sec ? "%+" + (s1 + 1) : "%+#" + (Math.round(s1) + 1 + REORDER)];
    const packs  = await Machine.exec([ffprobe, "-v", "error", "-select_streams", String(stream.index), ...upto, "-show_entries", "packet=pts_time", "-of", "csv=p=0", file], signal);
    const lines  = packs.out.toString().split("\n").filter((l) => l.trim() !== "");
    const zero   = Number(json.format?.start_time) || 0;
    const read   = packs.code === 0 && lines.length > 0 && lines.every((l) => Number.isFinite(parseFloat(l)));
    const sorted = read ? lines.map((l) => parseFloat(l) - zero).sort((a, b) => a - b) : null;
    const whole  = upto.length === 0 || (sec ? sorted !== null && sorted[sorted.length - 1] < s1 + 0.5 : lines.length < Math.round(s1) + 1 + REORDER);
    const times  = sorted === null || whole ? sorted : sec ? sorted.filter((t) => t <= s1 + 0.5) : sorted.slice(0, sorted.length - REORDER);
    const fps    = Machine.rate(stream.avg_frame_rate) || Machine.rate(stream.r_frame_rate);
    const secs   = Number(stream.duration ?? json.format?.duration);
    const nb     = Number(stream.nb_frames) > 0 ? Number(stream.nb_frames) : times !== null && whole ? times.length : 0;
    const total  = nb > 0 ? nb + " frames (0-" + (nb - 1) + ")" : secs > 0 && fps > 0 ? "about " + Math.round(secs * fps) + " frames" : "frame count unknown";
    const turned = Math.abs(Number(stream.side_data_list?.find((d: any) => d.rotation !== undefined)?.rotation) || 0) % 180 === 90;
    const [sa, sb] = String(stream.sample_aspect_ratio ?? "").split(":").map(Number);
    const wide   = Number(stream.width) * (sa > 0 && sb > 0 ? sa / sb : 1);
    const [w0, h0] = turned ? [Number(stream.height), wide] : [wide, Number(stream.height)];
    const about  = input.path + ": " + (secs > 0 ? +secs.toFixed(3) + " s, " : "") + +fps.toFixed(3) + " fps, " + total + ", " + Math.round(w0) + "x" + Math.round(h0) + ", " + stream.codec_name;
    if (sec && times === null && !(fps > 0)) {
      return { text: about + "\nIts frame times are unknown: give start and end in frames.", fail: true };
    }
    // a time's frame: the first at or after it (start), the last at or
    // before it (end)
    const frame  = (t: number, last: boolean) => (!sec ? Math.round(t) : times === null ? Math.round(t * fps) : last ? times.filter((x) => x <= t + 1e-6).length - 1 : times.filter((x) => x < t - 1e-6).length);
    const start  = frame(s0, false);
    const most   = nb > 0 ? nb - 1 : times !== null ? times.length - 1 : Infinity;
    const end    = Math.min(given(input.end) ? frame(s1, true) : most === Infinity ? start + 15 * (Number(input.step) || 1) : most, most);
    const step   = given(input.step) ? Math.floor(Number(input.step)) : Math.max(1, Math.ceil((end - start + 1) / 16));
    const why    = !(s0 >= 0) ? "start must be 0 or more" : start > most ? "start is past the last frame" : !(end >= start) ? "end must not be before start" : !(step >= 1) ? "step must be 1 or more" : "";
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
    const [w, h] = [2 * Math.floor((w0 * k) / 2), 2 * Math.floor((h0 * k) / 2)];
    if (Math.min(w, h) < CELL) {
      return { text: about + "\nmax_side " + side + " is too small for " + count + " frames (each under " + CELL + " px): raise max_side or take fewer frames.", fail: true };
    }
    const font  = Math.max(10, Math.round(Math.min(h / 10, w / 8)));
    const label = ":fontsize=" + font + ":fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=2:x=2";
    const seeks = times !== null && INDEXED.test(json.format?.format_name ?? "");
    const at    = (f: number) => (seeks && f > 0 ? (times![f - 1] + times![f]) / 2 : 0);
    const from  = (f: number) => (at(f) > 0 ? ["-ss", at(f).toFixed(6)] : []);
    const hms   = (t: number) => new Date(Math.max(0, t) * 1000).toISOString().slice(11, 23);
    const out   = ["-frames:v", "1", "-f", "image2pipe", "-c:v", "mjpeg", "-q:v", "3", "pipe:1"];
    const fit   = "scale=" + w + ":" + h + ",setsar=1";
    const grid  = "tile=" + cols + "x" + rows + ":nb_frames=" + count + ":padding=" + GAP + ":margin=" + GAP + ":color=white";
    const takes = Array.from({ length: count }, (_, i) => start + i * step);
    const apart = seeks && count > 1 && (times![takes[count - 1]] - times![start]) / (count - 1) > SPARSE;
    // the sheet, its frames stamped (or not: an ffmpeg without drawtext)
    // with number n and time t (text, or drawtext expressions)
    const sheet = async (stamp: boolean) => {
      const marks = (n: string, t: string) => (stamp ? ",drawtext=text='" + n + "'" + label + ":y=2,drawtext=text='" + t + "'" + label + ":y=h-th-4" : "");
      if (apart) {
        const shots: Buffer[] = [];
        for (const f of takes) {
          const one = await Machine.exec([ffmpeg, "-v", "error", ...from(f), "-i", file, "-map", "0:" + stream.index, "-vf", fit + marks(String(f), hms(times![f]).replaceAll(":", "\\:")), ...out], signal);
          if (one.code !== 0 || one.out.length === 0) {
            return one;
          }
          shots.push(one.out);
        }
        return Machine.exec([ffmpeg, "-v", "error", "-f", "image2pipe", "-c:v", "mjpeg", "-i", "pipe:0", "-vf", grid, ...out], signal, Buffer.concat(shots));
      }
      const first = seeks ? 0 : start;
      const which = "select='between(n," + first + "," + (end - start + first) + ")*not(mod(n-" + first + "," + step + "))',";
      const marked = marks("%{eif\\:n*" + step + "+" + start + "\\:d}", "%{pts\\:hms\\:" + at(start) + "}");
      return Machine.exec([ffmpeg, "-v", "error", ...from(start), "-i", file, "-map", "0:" + stream.index, "-vf", which + fit + marked + "," + grid, ...out], signal);
    };
    let made    = await sheet(true);
    let note    = "";
    if (made.code !== 0 && /drawtext|font/i.test(made.err)) {
      made = await sheet(false);
      note = "; this ffmpeg can't draw text, so they are unstamped: " + takes.map((f) => f + (times === null ? "" : " (" + hms(times[f]) + ")")).join(", ");
    }
    if (made.code !== 0 || made.out.length === 0) {
      return { text: about + "\nffmpeg: " + (made.err.trim() || "no frame in that range"), fail: true };
    }
    const range = "frames " + start + "-" + takes[count - 1] + (step > 1 ? " every " + step : "");
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
