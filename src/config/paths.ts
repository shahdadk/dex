import os from "node:os";
import path from "node:path";

export interface DexPaths {
  home: string;
  config: string;
  state: string;
  events: string;
  daemonPid: string;
  daemonLog: string;
  powerState: string;
  worktrees: string;
  handoffs: string;
  runtime: string;
  controlSocket: string;
}

export function resolveDexPaths(home = process.env.DEX_HOME): DexPaths {
  const root = path.resolve(home || path.join(os.homedir(), ".dex"));
  return {
    home: root,
    config: path.join(root, "config.json"),
    state: path.join(root, "state.json"),
    events: path.join(root, "events.jsonl"),
    daemonPid: path.join(root, "daemon.pid"),
    daemonLog: path.join(root, "daemon.log"),
    powerState: path.join(root, "power-state.json"),
    worktrees: path.join(root, "worktrees"),
    handoffs: path.join(root, "handoffs"),
    runtime: path.join(root, "runtime"),
    controlSocket: path.join(root, "runtime", "control.sock"),
  };
}
