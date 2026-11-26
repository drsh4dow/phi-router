import { Array, Effect, Layer, Option, Schema, String as Str, Struct, pipe } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import type { Harness, World } from "./hooked.ts";
import { assert, it } from "@effect/vitest";
import { bodyOf, claudeRequest } from "#tools/route/mocked-router.ts";
import { canary, hook, session, setUp, setUpWith } from "./hooked.ts";
import type { AccountScript } from "#tools/route/harnesses.ts";
import { NodeServices } from "@effect/platform-node";
import { freePort } from "#tools/lifecycle/launched.ts";
import { privacyUnder } from "#tools/route/private.ts";
import { stampClockIn } from "#tools/wire/stored.ts";

const patient = { timeout: 120_000 };

const Notice = Schema.fromJsonString(Schema.Struct({ systemMessage: Schema.String }));

const stopInput = `{"session_id":"${session}","cwd":"/work","hook_event_name":"Stop","stop_hook_active":false}`;

const noticeFile = "cy1waGktaG9va3M.json";

const quiet = { exitCode: 0, stderr: "", stdout: "" };

const turnEnd = Effect.fnUntraced(function* turnEnd(
	world: World,
	harness: Harness,
	addressed: { readonly address?: string },
) {
	return yield* hook(world, Struct.assign(addressed, { event: "Stop" as const, harness, input: stopInput }));
});

const noticed = Effect.fnUntraced(function* noticed(world: World, harness: Harness, address: string) {
	const hooked = yield* turnEnd(world, harness, { address });
	const { systemMessage } = yield* Schema.decodeEffect(Notice)(hooked.stdout);

	return Struct.assign(hooked, { stdout: systemMessage });
});

const turnOn = Effect.fnUntraced(function* turnOn(url: string, text: string) {
	const client = yield* HttpClient.HttpClient;
	const body = yield* bodyOf([{ role: "user", text }]);
	const response = yield* client.execute(HttpClientRequest.prependUrl(claudeRequest({ body, session }), url));

	yield* response.text;
}, Effect.scoped);

const announced = Effect.fnUntraced(function* announced(harness: Harness) {
	const world = yield* setUp;
	const before = yield* turnEnd(world, harness, { address: world.routerUrl });

	yield* turnOn(world.routerUrl, `Patient Fakesmith ${canary} called about her refill.`);

	const sealed = yield* noticed(world, harness, world.routerUrl);
	const after = yield* turnEnd(world, harness, { address: world.routerUrl });
	const { notPrivate, shown } = yield* privacyUnder([world.folders.XDG_STATE_HOME]);
	const notices = pipe(shown, Array.filter(Str.includes("/phi-router/notices")));

	assert.deepStrictEqual(
		{ after, before, notPrivate, notices, sealed },
		{
			after: quiet,
			before: quiet,
			notPrivate: Array.empty<string>(),
			notices: [
				`${world.folders.XDG_STATE_HOME}/phi-router/notices 700`,
				`${world.folders.XDG_STATE_HOME}/phi-router/notices/${noticeFile} 600`,
			],
			sealed: {
				exitCode: 0,
				stderr: "",
				stdout:
					"phi-router: 1 message held patient identifiers. The open account sees a handle in place of each. Last request: open, model target-under-test.",
			},
		},
	);
}, Effect.scoped);

const down = Effect.gen(function* down() {
	const world = yield* setUp;
	const port = yield* freePort;
	const told = yield* noticed(world, "claude", `http://127.0.0.1:${String(port)}`);
	const unrouted = yield* turnEnd(world, "claude", {});

	assert.deepStrictEqual(
		{ told, unrouted },
		{
			told: {
				exitCode: 0,
				stderr: "",
				stdout: `phi-router status --port ${String(port)}: no router answers there. A protected session starts the router.`,
			},
			unrouted: quiet,
		},
	);
}).pipe(Effect.scoped);

const limited: AccountScript = () => ({ body: "{}", kind: "status", status: 429 });

const Blocked = Schema.fromJsonString(Schema.Struct({ reason: Schema.String }));

const overflowed = Effect.fnUntraced(function* overflowed(harness: Harness) {
	const world = yield* setUpWith({ open: limited });

	yield* turnOn(world.routerUrl, "List the build steps.");

	const told = yield* noticed(world, harness, world.routerUrl);

	yield* turnOn(world.routerUrl, "And the test steps.");

	const quietTurn = yield* turnEnd(world, harness, { address: world.routerUrl });

	const phi = yield* hook(world, {
		address: world.routerUrl,
		event: "UserPromptSubmit",
		harness,
		input: `{"session_id":"${session}","prompt":"/phi"}`,
	});

	const { reason } = yield* Schema.decodeEffect(Blocked)(phi.stdout);
	const back = yield* stampClockIn(`${world.folders.XDG_STATE_HOME}/phi-router`);

	assert.deepStrictEqual(
		{ clean: Array.findFirst(Str.split(reason, "\n"), Str.startsWith("Clean lane")), quietTurn, told },
		{
			clean: Option.some(`Clean lane: open (rate-limited until ${back})`),
			quietTurn: quiet,
			told: {
				exitCode: 0,
				stderr: "",
				stdout: `phi-router: your subscription is rate-limited until ${back}, so 1 request ran on your BAA account. Add another subscription: npx phi-router accounts add`,
			},
		},
	);
}, Effect.scoped);

it.layer(Layer.merge(NodeServices.layer, FetchHttpClient.layer))("the plugin's turn-end hook", (test) => {
	test.effect.each(["claude", "codex"] as const)(
		"for %s, announces a turn that sealed once, from a count kept 0600 in 0700",
		announced,
		patient,
	);
	test.effect(
		"says no router answers when none does, and prints nothing when the address names no router",
		() => down,
		patient,
	);
	test.effect.each(["claude", "codex"] as const)(
		"for %s, tells once that a rate-limited subscription sent a request to the BAA account, and /phi shows when it is back",
		overflowed,
		patient,
	);
});
