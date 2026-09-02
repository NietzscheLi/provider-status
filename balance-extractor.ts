import { objectAt, valueAt } from "./config.ts";
import type { JsonObject } from "./types.ts";

function numberValue(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const result = Number(value); return Number.isFinite(result) ? result : null;
}
function interpolate(value: string, vars: Record<string, string>): string {
  return value.replace(/\{\{(\w+)\}\}/g, (_m, key: string) => {
    const result = vars[key]; if (!result) throw new Error(`Missing balance variable: ${key}`); return result;
  });
}
export function extractBalance(body: unknown, extractor: JsonObject): string {
  const validity = objectAt(extractor, "validity");
  // 无效响应的错误信息：优先从响应 errorPath 读取，否则用 errorFallback。
  const invalid = (): Error => {
    const raw = extractor.errorPath === undefined ? undefined : valueAt(body, String(extractor.errorPath));
    return new Error(typeof raw === "string" && raw ? raw : String(extractor.errorFallback ?? "Balance query failed"));
  };
  if (validity?.path && !Boolean(valueAt(body, String(validity.path)))) throw invalid();
  if (Array.isArray(validity?.allTruthy) && !validity.allTruthy.every((p) => typeof p === "string" && Boolean(valueAt(body, p)))) throw invalid();
  if (Array.isArray(validity?.firstDefined)) {
    // 按顺序取第一个存在的字段判断状态；都不存在时使用 fallback 决定有效性。
    const first = validity.firstDefined.find((p) => typeof p === "string" && valueAt(body, p) !== undefined);
    if (first === undefined) {
      if (!Boolean(validity?.fallback)) throw invalid();
    } else if (!Boolean(valueAt(body, first))) {
      throw invalid();
    }
  }
  let remaining: number | null;
  if (typeof extractor.remainingPath === "string") remaining = numberValue(valueAt(body, extractor.remainingPath));
  else {
    const total = numberValue(valueAt(body, String(extractor.totalPath ?? "")));
    const used = numberValue(valueAt(body, String(extractor.usedPath ?? "")));
    remaining = total === null || used === null ? null : total - used;
  }
  if (remaining === null) throw new Error("Balance fields are missing");
  const scale = numberValue(extractor.scale) ?? 1;
  if (scale === null || !Number.isFinite(scale)) throw new Error("Invalid balance scale");
  const unit = typeof extractor.unit === "string" ? extractor.unit : String(valueAt(body, String(extractor.unitPath ?? "")) ?? "");
  return `${unit}${(remaining * scale).toLocaleString("en-US", { maximumFractionDigits: 4 })}`;
}
export function interpolateObject(value: unknown, vars: Record<string, string>): unknown {
  if (typeof value === "string") return interpolate(value, vars);
  if (Array.isArray(value)) return value.map((item) => interpolateObject(item, vars));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolateObject(v, vars)]));
  return value;
}
