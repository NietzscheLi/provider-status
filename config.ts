import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import type { BalanceConfig, JsonObject } from "./types.ts";

export const CONFIG_NAME = "balance-config.yaml";
export const PROFILES = ["newapi", "sub2api", "deepseek-official", "openrouter"] as const;

const DEFAULT_CONFIG: BalanceConfig = { refreshIntervalMinutes: 5, profiles: {}, providers: {} };

export function configPath(agentDir: string): string { return join(agentDir, CONFIG_NAME); }
export function readConfig(agentDir: string): BalanceConfig {
  const path = configPath(agentDir);
  if (!existsSync(path)) return structuredClone(DEFAULT_CONFIG);
  const value: unknown = parse(readFileSync(path, "utf8"), { merge: true });
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${CONFIG_NAME} root must be an object`);
  return value as BalanceConfig;
}
export function refreshInterval(config: BalanceConfig): number {
  const value = Number(config.refreshIntervalMinutes);
  return Number.isFinite(value) && value >= 1 ? value : 5;
}
export function objectAt(value: unknown, path: string): JsonObject | undefined {
  const result = path ? valueAt(value, path) : value;
  return result && typeof result === "object" && !Array.isArray(result) ? result as JsonObject : undefined;
}
export function valueAt(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, key) => {
    if (current === null || typeof current !== "object") return undefined;
    if (Array.isArray(current)) return /^\d+$/.test(key) ? current[Number(key)] : undefined;
    return (current as JsonObject)[key];
  }, value);
}
