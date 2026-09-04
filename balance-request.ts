import { objectAt, readConfig, valueAt } from "./config.ts";
import { BUILTIN_PROFILES } from "./builtin.ts";
import { extractBalance, interpolateObject } from "./balance-extractor.ts";
import type { BalanceSource, FetchLike, JsonObject } from "./types.ts";

// 参照 pi-usage 的有界响应读取：余额接口响应体很小，超限视为异常，防止异常端点拖垮内存。
const MAX_BODY_BYTES = 64 * 1024;

async function readBoundedBody(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`Balance response exceeded ${MAX_BODY_BYTES} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(body);
}

export async function requestBalance(agentDir: string, providerId: string, source: BalanceSource, fetcher: FetchLike = globalThis.fetch, signal?: AbortSignal): Promise<string> {
  const config = readConfig(agentDir);
  const provider = objectAt(config.providers?.[providerId], "") ?? undefined;
  if (!provider) throw new Error(`Balance is not configured for ${providerId}`);
  // profile 既支持字符串引用（profiles 表中的名字），也支持内联对象/YAML 别名展开出的对象。
  const rawProfile = provider.profile;
  let profile: JsonObject | undefined;
  if (typeof rawProfile === "string") {
    profile = objectAt(config.profiles?.[rawProfile], "");
    // 配置文件里没有同名模板时回退到内置模板（如 openrouter）；用户同名自定义优先。
    profile ??= BUILTIN_PROFILES[rawProfile];
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
  // 超时（timeoutSeconds）与外部中止（切换 provider/session）共同生效。
  const timeout = AbortSignal.timeout(Math.max(1, Number(request.timeoutSeconds ?? 10)) * 1000);
  const combined = signal ? AbortSignal.any([timeout, signal]) : timeout;
  const response = await fetcher(url, { method: String(request.method ?? "GET"), headers, body: request.body === undefined ? undefined : JSON.stringify(interpolateObject(request.body, vars)), signal: combined });
  if (!response.ok) throw new Error(`Balance API error (${response.status})`);
  return extractBalance(JSON.parse(await readBoundedBody(response)), extractor);
}
