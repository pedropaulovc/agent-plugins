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

function providerPayload(description = "Execute shell commands") {
	return {
		instructions: "wire system instructions",
		input: [{ role: "user", content: "do not persist this transcript" }],
		tools: [
			{
				type: "function",
				name: "bash",
				description,
				parameters: {
					type: "object",
					properties: { command: { type: "string" } },
					required: ["command"],
				},
			},
		],
	};
}

async function capturePrompt(handlers, prompt, entries = [], payload = providerPayload()) {
	const agentStart = firstHandler(handlers, "agent_start");
	const beforeProviderRequest = firstHandler(handlers, "before_provider_request");
	await agentStart({ type: "agent_start" }, context(prompt, entries));
	await beforeProviderRequest({ type: "before_provider_request", payload }, context(prompt, entries));
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

	for (const event of ["session_start", "session_switch", "session_branch", "agent_start", "before_provider_request"]) {
		assert.equal((handlers.get(event) ?? []).length, 1, `missing ${event} handler`);
	}
});

test("captures defensive snapshots of prompt and provider tool context", async () => {
	const { handlers, appends } = await loadExtension();
	const systemPrompt = ["base instructions", "dynamic context"];
	const payload = providerPayload();

	await capturePrompt(handlers, systemPrompt, [], payload);
	systemPrompt[0] = "mutated after capture";
	payload.instructions = "mutated after capture";
	payload.tools[0].description = "mutated after capture";

	assert.deepEqual(appends, [
		{
			customType: "omp-system-prompt",
			data: {
				systemPrompt: ["base instructions", "dynamic context"],
				providerContext: {
					instructions: "wire system instructions",
					tools: [
						{
							type: "function",
							name: "bash",
							description: "Execute shell commands",
							parameters: {
								type: "object",
								properties: { command: { type: "string" } },
								required: ["command"],
							},
						},
					],
				},
			},
		},
	]);
});

test("does not persist provider input messages", async () => {
	const { handlers, appends } = await loadExtension();

	await capturePrompt(handlers, ["base"], [], providerPayload());

	assert.equal("input" in appends[0].data.providerContext, false);
});

test("does not duplicate a prompt, but records later prompt changes", async () => {
	const { handlers, appends } = await loadExtension();
	const entries = [];
	const firstPrompt = ["base"];
	const samePrompt = ["base"];
	const changedPrompt = ["base", "tool instructions"];
	const payload = providerPayload();

	await capturePrompt(handlers, firstPrompt, entries, payload);
	await capturePrompt(handlers, samePrompt, entries, payload);
	await capturePrompt(handlers, changedPrompt, entries, payload);

	assert.equal(appends.length, 2);
	assert.deepEqual(appends.map((entry) => entry.data.systemPrompt), [firstPrompt, changedPrompt]);
});

test("records changed provider tool definitions for the same prompt", async () => {
	const { handlers, appends } = await loadExtension();
	const prompt = ["base"];

	await capturePrompt(handlers, prompt, [], providerPayload("first"));
	await capturePrompt(handlers, prompt, [], providerPayload("second"));

	assert.equal(appends.length, 2);
	assert.deepEqual(appends.map((entry) => entry.data.providerContext.tools[0].description), ["first", "second"]);
});
test("records removal of provider context for the same prompt", async () => {
	const { handlers, appends } = await loadExtension();
	const prompt = ["base"];

	await capturePrompt(handlers, prompt, [], providerPayload());
	await capturePrompt(handlers, prompt, [], { input: ["no provider context"] });

	assert.equal(appends.length, 2);
	assert.equal("providerContext" in appends[1].data, false);
});

test("reuses a persisted prompt after extension reload", async () => {
	const { handlers, appends } = await loadExtension();
	const payload = providerPayload();
	const entries = [
		{
			type: "custom",
			customType: "omp-system-prompt",
			data: {
				systemPrompt: ["base"],
				providerContext: {
					instructions: payload.instructions,
					tools: payload.tools,
				},
			},
		},
		{
			type: "custom",
			customType: "omp-system-prompt",
			data: { systemPrompt: ["base", "tool instructions"] },
		},
	];

	await capturePrompt(handlers, ["base"], entries, payload);

	assert.deepEqual(appends, []);
});

test("upgrades an older prompt-only entry with provider tool context", async () => {
	const { handlers, appends } = await loadExtension();
	const entries = [
		{
			type: "custom",
			customType: "omp-system-prompt",
			data: { systemPrompt: ["base"] },
		},
	];

	await capturePrompt(handlers, ["base"], entries);

	assert.equal(appends.length, 1);
	assert.deepEqual(appends[0].data.systemPrompt, ["base"]);
	assert.equal(appends[0].data.providerContext.tools[0].name, "bash");
});

test("clears the in-memory cache when a branch is created", async () => {
	const { handlers, appends } = await loadExtension();
	const sessionBranch = firstHandler(handlers, "session_branch");
	const entries = [];
	const systemPrompt = ["base"];

	await capturePrompt(handlers, systemPrompt, entries);
	await sessionBranch({ type: "session_branch" }, context(systemPrompt, entries));
	await capturePrompt(handlers, systemPrompt, entries);

	assert.equal(appends.length, 2);
});
