import { Effect, Layer, Struct } from "effect";
import { assert, it } from "@effect/vitest";
import { bundled, instance, leasedPids, ran, routersOn, world } from "./launched.ts";
import { FetchHttpClient } from "effect/http";
import { NodeServices } from "@effect/platform-node";

const patient = { timeout: 90_000 };

const silent = { exitCode: 0, printed: "" };

const waiting = (running: string): string =>
	`phi-router 0.5.0 is installed. Your open windows still run ${running} until you close them all.`;

interface Hook {
	readonly entry: string;
	readonly pid: number;
	readonly event: string;
	readonly port: number;
	readonly env: Readonly<Record<string, string>>;
}

const hooked = Effect.fnUntraced(function* hooked({ entry, env, event, pid, port }: Hook) {
	const input = `{"session_id":"s-hook","cwd":"/work","hook_event_name":"${event}"}`;
	const address = `http://127.0.0.1:${String(port)}`;
	const piped = 'printf %s "$1" | node "$2" session-start --pid "$3" --address "$4"';

	return yield* ran(["sh", "-c", piped, "sh", input, entry, String(pid), address], env);
});

const newerJoins = Effect.fnUntraced(function* newerJoins(routerVersion: readonly string[], running: string) {
	const older = yield* bundled(...routerVersion);
	const newer = yield* bundled("0.5.0");
	const here = yield* world(older);
	const first = yield* instance();
	const second = yield* instance();
	const opened = yield* instance();

	yield* here.start(first.pid);

	const before = yield* routersOn(older, here.port);
	const joined = yield* here.start(second.pid, newer);
	const opening = { entry: newer, env: here.env, pid: opened.pid, port: here.port };
	const atSessionStart = yield* hooked(Struct.assign(opening, { event: "SessionStart" }));
	const atPrompt = yield* hooked(Struct.assign(opening, { event: "UserPromptSubmit" }));
	const after = yield* routersOn(older, here.port);
	const leases = yield* leasedPids(here.state);

	assert.deepStrictEqual(
		{ after, atPrompt, atSessionStart, joined, leases, newer: yield* routersOn(newer, here.port) },
		{
			after: before,
			atPrompt: silent,
			atSessionStart: { exitCode: 0, printed: `{"systemMessage":"${waiting(running)}"}\n` },
			joined: { exitCode: 0, printed: `${waiting(running)}\n` },
			leases: [first.pid, second.pid, opened.pid],
			newer: [],
		},
	);
}, Effect.scoped);

const olderJoins = Effect.fnUntraced(function* olderJoins() {
	const newer = yield* bundled("0.5.0");
	const older = yield* bundled("0.4.0");
	const here = yield* world(newer);
	const first = yield* instance();
	const second = yield* instance();

	yield* here.start(first.pid);

	const before = yield* routersOn(newer, here.port);
	const joined = yield* here.start(second.pid, older);

	const opened = yield* hooked({
		entry: older,
		env: here.env,
		event: "SessionStart",
		pid: second.pid,
		port: here.port,
	});

	assert.deepStrictEqual(
		{ after: yield* routersOn(newer, here.port), joined, opened },
		{ after: before, joined: silent, opened: silent },
	);
}, Effect.scoped);

it.layer(Layer.merge(NodeServices.layer, FetchHttpClient.layer), { excludeTestServices: true })(
	"a plugin newer than the running router",
	(test) => {
		test.effect(
			"joins the 0.4.0 router, leaves it running, and says so once, at the session's start",
			() => newerJoins(["0.4.0"], "0.4.0"),
			patient,
		);
		test.effect(
			"joins a router that reports no version and calls it an older version",
			() => newerJoins([], "an older version"),
			patient,
		);
		test.effect("an older plugin joins a newer router and says nothing", () => olderJoins(), patient);
	},
);
