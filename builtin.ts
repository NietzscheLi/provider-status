// pi 内置 provider 目录与内置余额模板的隔离读取。
//
// 内置 provider（如 openrouter）不出现在 models.json 里，但对账与编辑面板都必须
// 知道它们；读取通过独立 ModelRuntime 完成，不读用户 auth.json/models.json，
// 也不允许触发模型网络请求。失败时回退为空集合（行为与旧版一致）。

import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { JsonObject } from "./types.ts";

const emptyCredentialStore = {
	async read(): Promise<undefined> {
		return undefined;
	},
	async list(): Promise<readonly []> {
		return [];
	},
	async modify(): Promise<undefined> {
		return undefined;
	},
	async delete(): Promise<void> {
		return undefined;
	},
};

let builtinProviderIdsPromise: Promise<ReadonlySet<string>> | undefined;

/** pi 内置 catalog 中的 provider ID 集合（缓存；失败回退空集合）。 */
export function getBuiltinProviderIds(): Promise<ReadonlySet<string>> {
	builtinProviderIdsPromise ??= ModelRuntime.create({
		credentials: emptyCredentialStore,
		modelsPath: null,
		allowModelNetwork: false,
	})
		.then(
			(runtime) =>
				new Set(
					runtime.getModels().map((model) => String(model.provider)),
				) as ReadonlySet<string>,
		)
		.catch(() => new Set<string>() as ReadonlySet<string>);

	return builtinProviderIdsPromise;
}

/**
 * 内置余额查询模板：providers 条目绑定同名 profile 时，
 * balance-config.yaml 的 profiles 段里没有同名模板也能直接使用。
 * 用户在 yaml 里自定义同名模板时优先级更高。
 */
export const BUILTIN_PROFILES: Readonly<Record<string, JsonObject>> = {
	openrouter: {
		request: {
			// 运行时会先去掉 baseUrl 末尾的 /v1 再拼接相对路径，避免出现 /api/api/v1。
			url: "{{baseUrl}}/v1/credits",
			method: "GET",
			headers: { Authorization: "Bearer {{apiKey}}" },
		},
		extractor: {
			totalPath: "data.total_credits",
			usedPath: "data.total_usage",
			unit: "$",
		},
	},
};

export function isBuiltinProfile(name: string): boolean {
	return name in BUILTIN_PROFILES;
}
