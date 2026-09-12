import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { LOCK_NAME, configPath, readConfig } from "./usage-config.ts";
import type { JsonObject, UsageConfig } from "./types.ts";

const LOCK_STALE_MS = 30_000;
const LOCK_TIMEOUT_MS = 5_000;

export class ExternalModificationError extends Error {
	constructor() {
		super("usage-config.yaml was modified outside of this extension; refusing to overwrite");
		this.name = "ExternalModificationError";
	}
}

export class LockConflictError extends Error {
	constructor() {
		super("usage-config.yaml is locked by another writer");
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
	config: UsageConfig;
	fingerprint: string;
	changed: boolean;
}

/**
 * Applies `mutate` to the usage config and persists it with temp-file + atomic
 * rename. Must be called inside `withConfigLock`. When `expectedFingerprint` is
 * provided and no longer matches the on-disk content, the write is rejected and
 * the file is left untouched.
 */
export function updateConfig(
	agentDir: string,
	mutate: (config: UsageConfig) => UsageConfig | undefined,
	expectedFingerprint?: string,
): ConfigUpdateResult {
	const path = configPath(agentDir);
	const currentFingerprint = configFingerprint(agentDir);
	if (expectedFingerprint !== undefined && expectedFingerprint !== currentFingerprint) throw new ExternalModificationError();
	const next = mutate(readConfig(agentDir));
	const fingerprint = currentFingerprint ?? "";
	if (!next) return { config: readConfig(agentDir), fingerprint, changed: false };
	const tempPath = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
	writeFileSync(tempPath, serializeUsageConfig(next), { mode: 0o600 });
	renameSync(tempPath, path);
	return { config: next, fingerprint: fingerprintFile(path)!, changed: true };
}

/**
 * TUI 编辑用：在独占锁内做一次读-改-写。配置内容每次都从磁盘重新读取，
 * 因此多次编辑之间不会互相覆盖；如需乐观并发控制，请直接使用 `updateConfig` 并传入指纹。
 */
export async function mutateConfig(
	agentDir: string,
	mutate: (config: UsageConfig) => UsageConfig | undefined,
): Promise<ConfigUpdateResult> {
	return withConfigLock(agentDir, () => updateConfig(agentDir, mutate));
}

export function serializeUsageConfig(config: UsageConfig): string {
	const body = stringifyYaml(config, { defaultStringType: "QUOTE_DOUBLE", lineWidth: 0 });
	return `# Managed by pi-provider-status. Quarantined orphan entries are preserved in orphanBalances.\n${body}`;
}

/** Removes any configured credential value from `message` before it reaches UI, logs or tests. */
export function redactSecrets(message: string, config: UsageConfig): string {
	let result = message;
	const sections = [config.profiles ?? {}, config.balances ?? {}, config.subscriptions ?? {}, config.orphanBalances ?? {}];
	for (const section of sections) {
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
