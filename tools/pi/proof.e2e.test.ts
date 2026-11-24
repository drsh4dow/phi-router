import { Array, Effect, FileSystem, Layer, Option, String as Str, Stream, pipe } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { assert, it } from "@effect/vitest";
import { secretKept, squatter } from "#tools/lifecycle/squatter.ts";
import { FetchHttpClient } from "effect/http";
import { NodeServices } from "@effect/platform-node";
import { folder } from "#tools/claude/configured.ts";
import { freePort } from "#tools/lifecycle/launched.ts";
import { packageCopy } from "#tools/plugin/copied.ts";
import { stopped } from "#tools/route/stopped.ts";

const patient = { timeout: 120_000 };

const piCli = decodeURIComponent(
	new URL("../../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js", import.meta.url).pathname,
);

const canary = "phi-canary-36";

const savedSession = `{"type":"session","version":3,"id":"s-compact","timestamp":"2026-11-23T00:00:00.000Z","cwd":"/tmp"}
{"type":"message","id":"t1","parentId":null,"timestamp":"2026-11-23T00:00:00.000Z","message":{"role":"user","content":[{"type":"text","text":"Reply with ok. ${canary}"}],"timestamp":0}}
{"type":"message","id":"t2","parentId":"t1","timestamp":"2026-11-23T00:00:00.000Z","message":{"role":"assistant","content":[{"type":"text","text":"ok"}],"timestamp":0,"api":"anthropic-messages","provider":"phi","model":"auto","stopReason":"stop","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}}}}
{"type":"message","id":"t3","parentId":"t2","timestamp":"2026-11-23T00:00:00.000Z","message":{"role":"user","content":[{"type":"text","text":"Reply with ok."}],"timestamp":0}}
{"type":"message","id":"t4","parentId":"t3","timestamp":"2026-11-23T00:00:00.000Z","message":{"role":"assistant","content":[{"type":"text","text":"ok"}],"timestamp":0,"api":"anthropic-messages","provider":"phi","model":"auto","stopReason":"stop","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}}}}
`;

const piWorld = Effect.fnUntraced(function* piWorld(port: number) {
	const fs = yield* FileSystem.FileSystem;

	const [home, agent, state] = yield* Effect.all(
		[folder("phi-pi-home-"), folder("phi-pi-"), folder("phi-pi-state-")],
		{ concurrency: 1 },
	);

	yield* secretKept(`${state}/phi-router`);
	yield* fs.writeFileString(`${agent}/settings.json`, '{"compaction":{"keepRecentTokens":1}}');
	yield* fs.writeFileString(`${home}/session.jsonl`, savedSession);

	const env = {
		ANTHROPIC_OAUTH_TOKEN: "phi-fake-login",
		HOME: home,
		PHI_ROUTER_PORT: String(port),
		PI_CODING_AGENT_DIR: agent,
		PI_OFFLINE: "1",
		PI_SKIP_VERSION_CHECK: "1",
		XDG_STATE_HOME: state,
	};

	return { env, home };
});

const piRun = Effect.fnUntraced(function* piRun(run: {
	readonly installed: string;
	readonly port: number;
	readonly args: (home: string) => readonly string[];
	readonly commands: readonly string[];
	readonly until: (line: string) => boolean;
}) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const { env, home } = yield* piWorld(run.port);
	const args = [piCli, ...run.args(home), "--model", "phi/auto", "--no-extensions", "-e", run.installed];

	const stdin = Array.match(run.commands, {
		onEmpty: () => "ignore" as const,
		onNonEmpty: (lines) => pipe(Stream.fromIterable(lines), Stream.encodeText, Stream.concat(Stream.never)),
	});

	const handle = yield* spawner.spawn(ChildProcess.make("bun", args, { cwd: home, env, extendEnv: true, stdin }));

	const lines = yield* pipe(
		Stream.merge(handle.stdout, handle.stderr),
		Stream.decodeText,
		Stream.splitLines,
		Stream.takeUntil(run.until),
		Stream.runCollect,
	);

	return Array.join(lines, "\n");
}, Effect.scoped);

const onlyAsked = (received: readonly string[]): void => {
	assert.isNotEmpty(received, "the extension asked the listener for its proof");
	assert.deepStrictEqual(
		pipe(
			received,
			Array.filter((sent) => sent !== "GET /phi-router/proof"),
		),
		[],
		"the listener got nonce requests alone, and no POST",
	);
};

const blocked = Effect.gen(function* blocked() {
	const other = yield* squatter;
	const installed = yield* packageCopy;

	const printed = yield* piRun({
		args: () => ["-p", `Reply with ok. ${canary}`],
		commands: [],
		installed,
		port: other.port,
		until: () => false,
	});

	assert.include(printed, `--port ${String(other.port)}: the port does not hold your router.`);

	const received = yield* other.received;

	onlyAsked(received);
}).pipe(Effect.scoped);

const compactionBlocked = Effect.gen(function* compactionBlocked() {
	const other = yield* squatter;
	const installed = yield* packageCopy;

	const printed = yield* piRun({
		args: (home) => ["--mode", "rpc", "--session", `${home}/session.jsonl`],
		commands: ['{"id":"c1","type":"compact"}\n'],
		installed,
		port: other.port,
		until: Str.includes('"id":"c1"'),
	});

	const answer = pipe(
		Str.split(printed, "\n"),
		Array.findFirst(Str.includes('"id":"c1"')),
		Option.getOrElse(() => ""),
	);

	assert.include(printed, `--port ${String(other.port)}: the port does not hold your router.`);
	assert.include(answer, '"error":"Compaction cancelled"');

	const received = yield* other.received;

	onlyAsked(received);
}).pipe(Effect.scoped);

const keyless = Effect.gen(function* keyless() {
	const installed = yield* packageCopy;
	const port = yield* freePort;

	const printed = yield* piRun({
		args: () => ["-p", `Reply with ok. ${canary}`],
		commands: [],
		installed,
		port,
		until: () => false,
	});

	assert.include(printed, stopped.noBaaKey("pi"));
}).pipe(Effect.scoped);

it.layer(Layer.merge(NodeServices.layer, FetchHttpClient.layer))("the pi package", (test) => {
	test.effect(
		"stops a prompt to phi with the line that names its setup command when config.json does not exist",
		() => keyless,
		patient,
	);
	test.effect("blocks a prompt to phi when another user's listener holds the router's port", () => blocked, patient);
	test.effect(
		"cancels a compaction on phi when another user's listener holds the router's port",
		() => compactionBlocked,
		patient,
	);
});
