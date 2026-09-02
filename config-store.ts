import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { configPath, readConfig } from "./config.ts";
import type { BalanceConfig, JsonObject } from "./types.ts";

export const LOCK_NAME = "balance-config.lock";
const LOCK_STALE_MS = 30_000;
const LOCK_TIMEOUT_MS = 5_000;

export class ExternalModificationError extends Error {
	constructor() {
		super("balance-config.yaml was modified outside of this extension; refusing to overwrite");
		this.name = "ExternalModificationError";
	}
}

export class LockConflictError extends Error {
	constructor() {
		super("balance-config.yaml is locked by another writer");
		this.name = "LockConflictError";
	}
}

export function fingerprintFile(path: string): string | undefined {
	if (!existsSync(path)) return undefined;
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function configFingerprint(agentDir: string): string | undefined {
	return fingerprintFile(configPath(agentDir));
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Runs `fn` while holding an exclusive, stale-tolerant lock file in `agentDir`. */
export async function withConfigLock<T>(agentDir: string, fn: () => Promise<T> | T): Promise<T> {
	const path = join(agentDir, LOCK_NAME);
	const deadline = Date.now() + LOCK_TIMEOUT_MS;
	let fd: number | undefined;
	for (;;) {
		try {
			fd = openSync(path, "wx");
			break;
		} catch {
			if (Date.now() > deadline) throw new LockConflictError();
			try {
				if (Date.now() - statSync(path).mtimeMs > LOCK_STALE_MS) {
					unlinkSync(path);
					continue;
				}
			} catch {
				continue;
			}
			await sleep(25);
		}
	}
	try {
		return await fn();
	} finally {
		try {
			closeSync(fd!);
		} catch {
			// already closed
		}
		try {
			unlinkSync(path);
		} catch {
			// already removed
		}
	}
}

export interface ConfigUpdateResult {
	config: BalanceConfig;
	fingerprint: string;
	changed: boolean;
}

/**
 * Applies `mutate` to the balance config and persists it with temp-file + atomic
 * rename. Must be called inside `withConfigLock`. When `expectedFingerprint` is
 * provided and no longer matches the on-disk content, the write is rejected and
 * the file is left untouched.
 */
export function updateConfig(
	agentDir: string,
	mutate: (config: BalanceConfig) => BalanceConfig | undefined,
	expectedFingerprint?: string,
): ConfigUpdateResult {
	const path = configPath(agentDir);
	const currentFingerprint = configFingerprint(agentDir);
	if (expectedFingerprint !== undefined && expectedFingerprint !== currentFingerprint) throw new ExternalModificationError();
	const next = mutate(readConfig(agentDir));
	const fingerprint = currentFingerprint ?? "";
	if (!next) return { config: readConfig(agentDir), fingerprint, changed: false };
	const tempPath = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
	writeFileSync(tempPath, serializeBalanceConfig(next), { mode: 0o600 });
	renameSync(tempPath, path);
	return { config: next, fingerprint: fingerprintFile(path)!, changed: true };
}

/**
 * TUI 编辑用：在独占锁内做一次读-改-写。配置内容每次都从磁盘重新读取，
 * 因此多次编辑之间不会互相覆盖；如需乐观并发控制，请直接使用 `updateConfig` 并传入指纹。
 */
export async function mutateConfig(
	agentDir: string,
	mutate: (config: BalanceConfig) => BalanceConfig | undefined,
): Promise<ConfigUpdateResult> {
	return withConfigLock(agentDir, () => updateConfig(agentDir, mutate));
}

export function serializeBalanceConfig(config: BalanceConfig): string {
	const body = stringifyYaml(config, { defaultStringType: "QUOTE_DOUBLE", lineWidth: 0 });
	return `# Managed by pi-provider-status. Quarantined orphan entries are preserved in orphanProviders.\n${body}`;
}

/** Removes any configured credential value from `message` before it reaches UI, logs or tests. */
export function redactSecrets(message: string, config: BalanceConfig): string {
	let result = message;
	for (const section of [config.profiles ?? {}, config.providers ?? {}, config.orphanProviders ?? {}]) {
		for (const entry of Object.values(section)) {
			if (!entry || typeof entry !== "object") continue;
			const credentials = (entry as JsonObject).credentials;
			if (!credentials || typeof credentials !== "object") continue;
			for (const value of Object.values(credentials as JsonObject)) {
				if (typeof value === "string" && value.length >= 4) result = result.split(value).join("***");
			}
		}
	}
	return result;
}
