import { copyFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const input = process.argv[2];
if (!input) {
  console.error("Usage: npm run render -- /absolute/path/to/iphone-recording.mov");
  process.exit(1);
}

const root = path.resolve(import.meta.dirname, "..");
const publicDir = path.join(root, "public");
const outputDir = path.join(root, "out");
mkdirSync(publicDir, { recursive: true });
mkdirSync(outputDir, { recursive: true });
copyFileSync(path.resolve(input), path.join(publicDir, "dex-demo.mov"));

const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", path.resolve(input)], { encoding: "utf8" });
if (probe.status !== 0) throw new Error("Could not inspect the phone recording");
const seconds = Number(probe.stdout.trim());
const clipPlaybackRate = Math.max(1, seconds / 30);

const result = spawnSync("npx", ["remotion", "render", "src/index.ts", "DexDemo", "out/dex-demo.mp4", `--props=${JSON.stringify({ clipPlaybackRate })}`, "--codec=h264"], { cwd: root, stdio: "inherit" });
process.exit(result.status ?? 1);
