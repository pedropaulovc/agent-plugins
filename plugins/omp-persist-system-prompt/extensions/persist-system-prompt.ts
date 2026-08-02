import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const ENTRY_TYPE = "omp-system-prompt";

export default function persistSystemPrompt(api: ExtensionAPI): void {
	let cachedSessionId: string | undefined;
	let cachedSystemPrompt: readonly string[] | undefined;

	const clearCache = (): void => {
		cachedSessionId = undefined;
		cachedSystemPrompt = undefined;
	};

	api.on("session_start", clearCache);
	api.on("session_switch", clearCache);
	api.on("session_branch", clearCache);
	api.on("agent_start", (_event, ctx) => {
		const systemPrompt = ctx.getSystemPrompt();
		if (!Array.isArray(systemPrompt)) return;

		const sessionId = ctx.sessionManager.getSessionId();
		if (sessionId === cachedSessionId && samePrompt(cachedSystemPrompt, systemPrompt)) return;

		if (hasPersistedPrompt(ctx.sessionManager.getBranch(), systemPrompt)) {
			cachedSessionId = sessionId;
			cachedSystemPrompt = [...systemPrompt];
			return;
		}

		const capturedPrompt = [...systemPrompt];
		api.appendEntry(ENTRY_TYPE, { systemPrompt: capturedPrompt });
		cachedSessionId = sessionId;
		cachedSystemPrompt = capturedPrompt;
	});
}

function hasPersistedPrompt(entries: readonly unknown[], current: readonly string[]): boolean {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
		if (!("type" in entry) || !("customType" in entry) || !("data" in entry)) continue;
		if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;

		const data = entry.data;
		if (typeof data !== "object" || data === null || Array.isArray(data)) continue;
		if (!("systemPrompt" in data) || !Array.isArray(data.systemPrompt)) continue;
		if (samePrompt(data.systemPrompt, current)) return true;
	}

	return false;
}

function samePrompt(previous: unknown, current: readonly string[]): boolean {
	if (!Array.isArray(previous) || previous.length !== current.length) return false;
	return previous.every((part, index) => typeof part === "string" && part === current[index]);
}
