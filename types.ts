export type JsonObject = Record<string, unknown>;
export interface BalanceConfig extends JsonObject {
  refreshIntervalMinutes?: number;
  profiles?: JsonObject;
  providers?: JsonObject;
  orphanProviders?: JsonObject;
}
export interface BalanceState { text: string; loading: boolean; error?: string; updatedAt?: number; }
export interface BalanceSource { baseUrl?: string; apiKey?: string; }
export interface BalanceResult { providerId: string; state: BalanceState; }
export interface FetchLike { (input: string | URL, init?: RequestInit): Promise<Response>; }
