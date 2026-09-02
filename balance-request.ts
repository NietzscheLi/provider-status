import { objectAt, readConfig, valueAt } from "./config.ts";
import { extractBalance, interpolateObject } from "./balance-extractor.ts";
import type { BalanceSource, FetchLike, JsonObject } from "./types.ts";

export async function requestBalance(agentDir: string, providerId: string, source: BalanceSource, fetcher: FetchLike = globalThis.fetch): Promise<string> {
  const config = readConfig(agentDir);
  const provider = objectAt(config.providers?.[providerId], "") ?? undefined;
  if (!provider) throw new Error(`Balance is not configured for ${providerId}`);
  // profile 既支持字符串引用（profiles 表中的名字），也支持内联对象/YAML 别名展开出的对象。
  const rawProfile = provider.profile;
  let profile: JsonObject | undefined;
  if (typeof rawProfile === "string") {
    profile = objectAt(config.profiles?.[rawProfile], "");
    if (!profile) throw new Error(`Unknown balance profile: ${rawProfile}`);
  } else if (rawProfile && typeof rawProfile === "object" && !Array.isArray(rawProfile)) {
    profile = rawProfile as JsonObject;
  }
  const request = { ...(objectAt(profile, "request") ?? {}), ...(objectAt(provider, "request") ?? {}) };
  const extractor = { ...(objectAt(profile, "extractor") ?? {}), ...(objectAt(provider, "extractor") ?? {}) };
  const credentials = { ...(objectAt(profile, "credentials") ?? {}), ...(objectAt(provider, "credentials") ?? {}) };
  const baseUrl = String(request.baseUrl ?? source.baseUrl ?? "").replace(/\/v1\/?$/, "");
  const vars = { baseUrl, apiKey: String(credentials.apiKey ?? source.apiKey ?? ""), accessToken: String(credentials.accessToken ?? source.apiKey ?? ""), userId: String(credentials.userId ?? "") };
  let url = interpolateObject(request.url, vars);
  if (typeof url !== "string" || !url) throw new Error("Balance request URL is missing");
  // 相对路径（如 /api/v1/credits）以 baseUrl 为根解析；完整 URL 或已含 {{baseUrl}} 的模板不受影响。
  if (!/^https?:\/\//i.test(url) && !url.startsWith("{{")) {
    if (!baseUrl) throw new Error("Balance request URL is missing");
    url = `${baseUrl}${url.startsWith("/") ? url : `/${url}`}`;
  }
  const headers = interpolateObject(request.headers ?? {}, vars) as Record<string, string>;
  const response = await fetcher(url, { method: String(request.method ?? "GET"), headers, body: request.body === undefined ? undefined : JSON.stringify(interpolateObject(request.body, vars)), signal: AbortSignal.timeout(Math.max(1, Number(request.timeoutSeconds ?? 10)) * 1000) });
  if (!response.ok) throw new Error(`Balance API error (${response.status})`);
  return extractBalance(await response.json(), extractor);
}
