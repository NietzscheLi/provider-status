export type JsonObject = Record<string, unknown>;

/** 订阅型 provider 的内置适配器 ID。 */
export type SubscriptionAdapterId =
	| "ollama"
	| "commandcode"
	| "opencode-go"
	| "glm"
	| "chatgpt"
	| "kimi";

/** 订阅额度窗口：percent 为已用百分比（0-100），resetsAt 为 ISO 时间（可能缺失）。 */
export interface UsageWindow {
	label: string;
	percent: number;
	resetsAt?: string;
}

/** 余额型结果：text 已完成单位与格式化（如 `$12.34`）。 */
export interface BalanceValue {
	kind: "balance";
	text: string;
}

/** 订阅型结果：text 为已渲染的窗口文本（如 `5h 2% · wk 1%`）。 */
export interface SubscriptionValue {
	kind: "subscription";
	text: string;
	windows: UsageWindow[];
}

export type UsageValue = BalanceValue | SubscriptionValue;

export interface UsageState {
	value?: UsageValue;
	loading: boolean;
	error?: string;
	updatedAt?: number;
}

/** 查询运行时解析出的凭据（来自 modelRegistry.getApiKeyAndHeaders）。 */
export interface UsageSource {
	baseUrl?: string;
	apiKey?: string;
	accessToken?: string;
	headers?: Record<string, string>;
}

export interface UsageResult {
	providerId: string;
	state: UsageState;
}

export interface FetchLike {
	(input: string | URL, init?: RequestInit): Promise<Response>;
}

export interface UsageConfig extends JsonObject {
	/** 自动刷新间隔（分钟）。 */
	refreshInterval?: number;
	/** 余额模板（公共请求/提取协议）；条目用 template 字段绑定。 */
	templates?: JsonObject;
	/** 余额型 provider 配置。 */
	balances?: JsonObject;
	/** 订阅型 provider 配置（adapter 指向内置适配器）。 */
	subscriptions?: JsonObject;
	/** 隔离的孤儿余额配置。 */
	orphans?: JsonObject;
	// 旧键（读取时归一化，见 usage-config.ts normalizeConfig）：
	// refreshIntervalMinutes / profiles / orphanBalances / orphanProviders / providers。
}
