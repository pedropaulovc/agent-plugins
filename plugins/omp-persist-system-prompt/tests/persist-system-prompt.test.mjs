import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const testDir = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(testDir, "..");
const packageJsonPath = resolve(pluginRoot, "package.json");
const extensionPath = resolve(pluginRoot, "extensions/persist-system-prompt.ts");

async function readPackageJson() {
	return JSON.parse(await readFile(packageJsonPath, "utf8"));
}

async function loadExtension() {
	const handlers = new Map();
	const appends = [];
	const api = {
		on(event, handler) {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event).push(handler);
		},
		appendEntry(customType, data) {
			appends.push({ customType, data });
		},
	};
	const module = await import(`${pathToFileURL(extensionPath).href}?cachebust=${Date.now()}-${Math.random()}`);
	module.default(api);
	return { handlers, appends };
}

function firstHandler(handlers, event) {
	const eventHandlers = handlers.get(event) ?? [];
	assert.equal(eventHandlers.length, 1, `expected one ${event} handler`);
	return eventHandlers[0];
}

function context(systemPrompt, entries = [], sessionId = "session-1") {
	return {
		getSystemPrompt: () => systemPrompt,
		sessionManager: {
			getSessionId: () => sessionId,
			getBranch: () => entries,
		},
	};
}

test("package.json declares an OMP extension entrypoint", async () => {
	const pkg = await readPackageJson();

	assert.equal(pkg.name, "@pedropaulovc/omp-persist-system-prompt");
	assert.deepEqual(pkg.omp.extensions, ["./extensions/persist-system-prompt.ts"]);
});

test("registers lifecycle handlers and agent_start", async () => {
	const { handlers } = await loadExtension();

	for (const event of ["session_start", "session_switch", "session_branch", "agent_start"]) {
		assert.equal((handlers.get(event) ?? []).length, 1, `missing ${event} handler`);
	}
});

test("captures a defensive snapshot of the effective system prompt", async () => {
	const { handlers, appends } = await loadExtension();
	const agentStart = firstHandler(handlers, "agent_start");
	const systemPrompt = ["base instructions", "dynamic context"];

	await agentStart({ type: "agent_start" }, context(systemPrompt));
	systemPrompt[0] = "mutated after capture";

	assert.deepEqual(appends, [
		{
			customType: "omp-system-prompt",
			data: { systemPrompt: ["base instructions", "dynamic context"] },
		},
	]);
});

test("does not duplicate a prompt, but records later prompt changes", async () => {
	const { handlers, appends } = await loadExtension();
	const agentStart = firstHandler(handlers, "agent_start");
	const entries = [];
	const firstPrompt = ["base"];
	const samePrompt = ["base"];
	const changedPrompt = ["base", "tool instructions"];
	const makeContext = (prompt) => context(prompt, entries);

	await agentStart({ type: "agent_start" }, makeContext(firstPrompt));
	await agentStart({ type: "agent_start" }, makeContext(samePrompt));
	await agentStart({ type: "agent_start" }, makeContext(changedPrompt));

	assert.equal(appends.length, 2);
	assert.deepEqual(appends.map((entry) => entry.data.systemPrompt), [firstPrompt, changedPrompt]);
});

test("reuses a persisted prompt after extension reload", async () => {
	const { handlers, appends } = await loadExtension();
	const agentStart = firstHandler(handlers, "agent_start");
	const entries = [
		{
			type: "custom",
			customType: "omp-system-prompt",
			data: { systemPrompt: ["base", "tool instructions"] },
		},
	];

	await agentStart(
		{ type: "agent_start" },
		context(["base", "tool instructions"], entries, "session-2"),
	);

	assert.deepEqual(appends, []);
});

test("clears the in-memory cache when a branch is created", async () => {
	const { handlers, appends } = await loadExtension();
	const agentStart = firstHandler(handlers, "agent_start");
	const sessionBranch = firstHandler(handlers, "session_branch");
	const entries = [];
	const systemPrompt = ["base"];

	await agentStart({ type: "agent_start" }, context(systemPrompt, entries));
	await sessionBranch({ type: "session_branch" }, context(systemPrompt, entries));
	await agentStart({ type: "agent_start" }, context(systemPrompt, entries));

	assert.equal(appends.length, 2);
});
