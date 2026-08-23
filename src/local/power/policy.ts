import type { BatteryReading } from "./battery.js";

export interface PowerThresholds {
  lowBatteryPercent: number;
}

export interface PowerPolicy {
  thresholds: Readonly<PowerThresholds>;
}

export const DEFAULT_POWER_THRESHOLDS: Readonly<PowerThresholds> = Object.freeze({
  lowBatteryPercent: 10,
});

export const DEFAULT_POWER_POLICY: Readonly<PowerPolicy> = Object.freeze({
  thresholds: DEFAULT_POWER_THRESHOLDS,
});

export function createPowerPolicy(
  thresholds: Partial<PowerThresholds> = {},
): Readonly<PowerPolicy> {
  const lowBatteryPercent =
    thresholds.lowBatteryPercent ?? DEFAULT_POWER_THRESHOLDS.lowBatteryPercent;
  if (
    !Number.isFinite(lowBatteryPercent) ||
    lowBatteryPercent < 0 ||
    lowBatteryPercent > 100
  ) {
    throw new RangeError("lowBatteryPercent must be between 0 and 100");
  }

  return Object.freeze({
    thresholds: Object.freeze({ lowBatteryPercent }),
  });
}

export function isLowBattery(
  reading: BatteryReading,
  policy: Readonly<PowerPolicy> = DEFAULT_POWER_POLICY,
): boolean {
  return (
    reading.powerSource === "battery" &&
    !reading.charging &&
    reading.batteryPercent <= policy.thresholds.lowBatteryPercent
  );
}
