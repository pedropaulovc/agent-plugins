import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const ENTRY_TYPE = "omp-system-prompt";
const PROVIDER_CONTEXT_KEYS = [
	"instructions",
	"system",
	"systemInstruction",
	"system_instruction",
	"tools",
	"toolConfig",
	"tool_config",
] as const;

/**
 * OMP keeps native tool schemas outside the textual system prompt. Capture only
 * provider fields that describe prompt/tool context; never persist conversation
 * input from the provider payload.
 */
type ProviderContextSnapshot = Record<string, unknown>;

export default function persistSystemPrompt(api: ExtensionAPI): void {
	let cachedSessionId: string | undefined;
	let cachedSystemPrompt: readonly string[] | undefined;
	let cachedProviderContext: ProviderContextSnapshot | undefined;
	let capturePending = false;

	const clearCache = (): void => {
		cachedSessionId = undefined;
		cachedSystemPrompt = undefined;
		cachedProviderContext = undefined;
		capturePending = false;
	};

	api.on("session_start", clearCache);
	api.on("session_switch", clearCache);
	api.on("session_branch", clearCache);
	api.on("agent_start", (_event, ctx) => {
		capturePending = Array.isArray(ctx.getSystemPrompt());
	});
	api.on("before_provider_request", (event, ctx) => {
		if (!capturePending) return;

		const systemPrompt = ctx.getSystemPrompt();
		if (!Array.isArray(systemPrompt)) return;

		const providerContext = snapshotProviderContext(event.payload);
		const sessionId = ctx.sessionManager.getSessionId();
		if (
			sessionId === cachedSessionId &&
			samePrompt(cachedSystemPrompt, systemPrompt) &&
			sameProviderContext(cachedProviderContext, providerContext)
		) {
			capturePending = false;
			return;
		}

		if (hasPersistedPrompt(ctx.sessionManager.getBranch(), systemPrompt, providerContext)) {
			cachedSessionId = sessionId;
			cachedSystemPrompt = [...systemPrompt];
			cachedProviderContext = providerContext;
			capturePending = false;
			return;
		}

		const capturedPrompt = [...systemPrompt];
		api.appendEntry(ENTRY_TYPE, {
			systemPrompt: capturedPrompt,
			...(providerContext ? { providerContext } : {}),
		});
		cachedSessionId = sessionId;
		cachedSystemPrompt = capturedPrompt;
		cachedProviderContext = providerContext;
		capturePending = false;
	});
}

function hasPersistedPrompt(
	entries: readonly unknown[],
	current: readonly string[],
	providerContext: ProviderContextSnapshot | undefined,
): boolean {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
		if (!("type" in entry) || !("customType" in entry) || !("data" in entry)) continue;
		if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;

		const data = entry.data;
		if (typeof data !== "object" || data === null || Array.isArray(data)) continue;
		if (!("systemPrompt" in data) || !Array.isArray(data.systemPrompt)) continue;
		if (!samePrompt(data.systemPrompt, current)) continue;

		const persistedProviderContext = "providerContext" in data ? data.providerContext : undefined;
		if (sameProviderContext(persistedProviderContext, providerContext)) return true;
	}

	return false;
}

function snapshotProviderContext(payload: unknown): ProviderContextSnapshot | undefined {
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;

	const source = payload as Record<string, unknown>;
	const snapshot: ProviderContextSnapshot = {};
	for (const key of PROVIDER_CONTEXT_KEYS) {
		if (!(key in source) || source[key] === undefined) continue;
		snapshot[key] = cloneJson(source[key]);
	}

	return Object.keys(snapshot).length > 0 ? snapshot : undefined;
}

function cloneJson(value: unknown): unknown {
	if (value === null || typeof value !== "object") return value;
	if (Array.isArray(value)) return value.map(cloneJson);

	const source = value as Record<string, unknown>;
	const clone: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(source)) {
		if (entry === undefined || typeof entry === "function" || typeof entry === "symbol") continue;
		clone[key] = cloneJson(entry);
	}
	return clone;
}

function sameProviderContext(previous: unknown, current: ProviderContextSnapshot | undefined): boolean {
	if (current === undefined) return previous === undefined;
	return sameJson(previous, current);
}

function sameJson(previous: unknown, current: unknown): boolean {
	if (previous === current) return true;
	if (Array.isArray(previous) || Array.isArray(current)) {
		if (!Array.isArray(previous) || !Array.isArray(current) || previous.length !== current.length) return false;
		return previous.every((value, index) => sameJson(value, current[index]));
	}

	const previousIsObject = typeof previous === "object" && previous !== null && !Array.isArray(previous);
	const currentIsObject = typeof current === "object" && current !== null && !Array.isArray(current);
	if (previousIsObject || currentIsObject) {
		if (!previousIsObject || !currentIsObject) return false;
		const previousRecord = previous as Record<string, unknown>;
		const currentRecord = current as Record<string, unknown>;
		const previousKeys = Object.keys(previousRecord).sort();
		const currentKeys = Object.keys(currentRecord).sort();
		if (previousKeys.length !== currentKeys.length) return false;
		return previousKeys.every(
			(key, index) => key === currentKeys[index] && sameJson(previousRecord[key], currentRecord[key]),
		);
	}

	return false;
}

function samePrompt(previous: unknown, current: readonly string[]): boolean {
	if (!Array.isArray(previous) || previous.length !== current.length) return false;
	return previous.every((part, index) => typeof part === "string" && part === current[index]);
}
