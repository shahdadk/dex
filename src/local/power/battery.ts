import { execFile, type ExecResult } from "../../utils/exec.js";

export type BatteryPowerSource = "ac" | "battery" | "ups" | "unknown";

export interface BatteryReading {
  batteryPercent: number;
  charging: boolean;
  powerSource: BatteryPowerSource;
  remainingMinutes: number | null;
  simulated: boolean;
}

export type PowerCommandExecutor = (
  command: string,
  args: readonly string[],
) => Promise<ExecResult>;

export class BatteryParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BatteryParseError";
  }
}

function parsePowerSource(output: string): BatteryPowerSource {
  const description = /Now drawing from\s+["']([^"']+)["']/i.exec(output)?.[1]
    ?.trim()
    .toLowerCase();

  if (description?.includes("battery")) return "battery";
  if (description?.includes("ups")) return "ups";
  if (description?.includes("ac")) return "ac";
  return "unknown";
}

function batteryDetailLine(output: string): string {
  const lines = output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => /\b\d{1,3}\s*%/u.test(line));

  const internalBattery = lines.find((line) => /InternalBattery|Battery-/i.test(line));
  const line = internalBattery ?? lines[0];
  if (!line) {
    throw new BatteryParseError("pmset output did not contain a battery percentage");
  }
  return line;
}

function parseRemainingMinutes(line: string): number | null {
  const match = /\b(\d+):(\d{2})\s+remaining\b/i.exec(line);
  if (!match) return null;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isSafeInteger(hours) || !Number.isSafeInteger(minutes) || minutes > 59) {
    return null;
  }
  return hours * 60 + minutes;
}

function inferPowerSource(line: string): BatteryPowerSource {
  if (/\bdischarging\b/i.test(line)) return "battery";
  if (/\b(?:charging|charged|AC attached)\b/i.test(line)) return "ac";
  return "unknown";
}

export function parsePmsetBattery(
  output: string,
  options: { simulated?: boolean } = {},
): BatteryReading {
  const line = batteryDetailLine(output);
  const percentageText = /\b(\d{1,3})\s*%/u.exec(line)?.[1];
  const batteryPercent = Number(percentageText);
  if (!Number.isInteger(batteryPercent) || batteryPercent < 0 || batteryPercent > 100) {
    throw new BatteryParseError(`invalid battery percentage: ${percentageText ?? "missing"}`);
  }

  const explicitlyNotCharging = /\b(?:not charging|discharging)\b/i.test(line);
  const charging = !explicitlyNotCharging && /\b(?:charging|finishing charge)\b/i.test(line);
  const parsedSource = parsePowerSource(output);

  return {
    batteryPercent,
    charging,
    powerSource: parsedSource === "unknown" ? inferPowerSource(line) : parsedSource,
    remainingMinutes: parseRemainingMinutes(line),
    simulated: options.simulated ?? false,
  };
}

export function simulatedBatteryReading(
  reading: Omit<BatteryReading, "simulated">,
): BatteryReading {
  return { ...reading, simulated: true };
}

export async function readBattery(
  executor: PowerCommandExecutor = execFile,
): Promise<BatteryReading> {
  const result = await executor("/usr/bin/pmset", ["-g", "batt"]);
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || `exit code ${result.exitCode}`;
    throw new Error(`pmset battery query failed: ${detail}`);
  }
  return parsePmsetBattery(result.stdout);
}
