// Build
// =====
// `bun Build.ts [target] [outfile]` (`bun run build`): one `unii`
// executable for a Bun target (default this machine's: bun-linux-x64,
// bun-linux-arm64, -musl, bun-darwin-arm64, bun-darwin-x64,
// bun-windows-x64), carrying that platform's Claude Code for claude-sub
// (ClaudeSub.ts writes it out on first use), so none needs installing. A
// platform's package missing from node_modules (`bun install` fetches
// only this machine's) is fetched with `npm pack`, at the SDK's version.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const HERE = import.meta.dir;
const SDK  = HERE + "/node_modules/@anthropic-ai/claude-agent-sdk";

const here   = (process.platform === "win32" ? "windows" : process.platform) + "-" + process.arch;
const target = process.argv[2] ?? "bun-" + here;
const parts  = target.replace(/^bun-/, "").split("-");
const win    = parts[0] === "windows";
const pkg    = "@anthropic-ai/claude-agent-sdk-" + [win ? "win32" : parts[0], ...parts.slice(1)].join("-");
const exe    = HERE + "/node_modules/" + pkg + (win ? "/claude.exe" : "/claude");
const out    = process.argv[3] ?? (win ? "unii.exe" : "unii");

function run(cmd: string[], cwd = HERE): void {
  const p = Bun.spawnSync(cmd, { cwd, stdio: ["inherit", "inherit", "inherit"] });
  if (p.exitCode !== 0) {
    throw new Error(cmd.join(" ") + ": exit " + p.exitCode);
  }
}

if (!fs.existsSync(SDK)) {
  throw new Error("run `bun install` first");
}
if (!fs.existsSync(exe)) {
  const version = JSON.parse(fs.readFileSync(SDK + "/package.json", "utf8")).version;
  const tmp = fs.mkdtempSync(os.tmpdir() + "/unii-build-");
  try {
    run(["npm", "pack", pkg + "@" + version, "--pack-destination", tmp], tmp);
    const tgz = fs.readdirSync(tmp).find((f) => f.endsWith(".tgz"))!;
    const dir = path.dirname(exe);
    fs.mkdirSync(dir, { recursive: true });
    run(["tar", "-xzf", path.join(tmp, tgz), "-C", dir, "--strip-components=1"]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
run(["bun", "build", "--compile", "--target=" + target, "Term.ts", exe, "--outfile", out]);
