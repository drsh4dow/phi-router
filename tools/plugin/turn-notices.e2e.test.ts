import { Array, Effect, Layer, Option, Schema, String as Str, Struct, pipe } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import type { Harness, World } from "./hooked.ts";
import { assert, it } from "@effect/vitest";
import { bodyOf, claudeRequest } from "#tools/route/mocked-router.ts";
import { canary, everyHook, hook, session, setUp, setUpWith } from "./hooked.ts";
import { freePort, ran as launched } from "#tools/lifecycle/launched.ts";
import type { AccountScript } from "#tools/route/harnesses.ts";
import { NodeServices } from "@effect/platform-node";
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
	const told = yield* noticed(world, "codex", `http://127.0.0.1:${String(port)}`);

	assert.deepStrictEqual(told, {
		exitCode: 0,
		stderr: "",
		stdout: `phi-router status --port ${String(port)}: no router answers there. A protected session starts the router.`,
	});
}).pipe(Effect.scoped);

const limited: AccountScript = () => ({ body: "{}", kind: "status", status: 429 });

const Blocked = Schema.fromJsonString(Schema.Struct({ reason: Schema.String }));

const overflowed = Effect.gen(function* overflowed() {
	const harness = "codex";
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
			clean: Option.some(`Clean lane: open (rate-limited, tried again at ${back})`),
			quietTurn: quiet,
			told: {
				exitCode: 0,
				stderr: "",
				stdout: `phi-router: your subscription hit its rate limit, so 1 request ran on your BAA account. phi-router tries it again at ${back}. Add another subscription: npx phi-router accounts add`,
			},
		},
	);
}).pipe(Effect.scoped);

const hookInputs = {
	PreCompact: `{"session_id":"${session}","cwd":"/work","hook_event_name":"PreCompact","trigger":"manual"}`,
	SessionStart: `{"session_id":"${session}","cwd":"/work","hook_event_name":"SessionStart","source":"startup"}`,
	Stop: stopInput,
	UserPromptSubmit: `{"session_id":"${session}","cwd":"/work","hook_event_name":"UserPromptSubmit","prompt":"hello there","transcript_path":"/work/session.jsonl"}`,
} as const;

const Shown = Schema.fromJsonString(Schema.Struct({ line: Schema.String, reply: Schema.String }));

const printedBy = Effect.fnUntraced(function* printedBy(world: World, event: keyof typeof hookInputs) {
	const ran = yield* everyHook(world, {
		address: world.routerUrl,
		event,
		harness: "claude",
		input: hookInputs[event],
	});

	return pipe(
		ran,
		Array.map(({ exitCode, stdout }) => ({ exitCode, stdout })),
	);
});

const claudeQuiet = Effect.gen(function* claudeQuiet() {
	const world = yield* setUpWith({ open: limited });

	yield* turnOn(world.routerUrl, `Patient Fakesmith ${canary} called about her refill.`);
	yield* turnOn(world.routerUrl, "List the build steps.");

	const inOrder = ["SessionStart", "UserPromptSubmit", "Stop", "PreCompact"] as const;
	const printed = yield* Effect.forEach(inOrder, (event) => printedBy(world, event), { concurrency: 1 });

	const statusline = yield* launched(
		[`${world.pluginCopy}/bin/phi-router`, "statusline", "--address", world.routerUrl, "--session", session],
		Struct.assign(world.folders, { HOME: world.home, TZ: "UTC" }),
	);

	const shown = yield* Schema.decodeEffect(Shown)(statusline.printed);
	const back = yield* stampClockIn(`${world.folders.XDG_STATE_HOME}/phi-router`);
	const silent = { exitCode: 0, stdout: "" };

	assert.deepStrictEqual(
		{
			line: shown.line,
			overflow: Array.findFirst(Str.split(shown.reply, "\n"), Str.startsWith("Overflow")),
			printed,
		},
		{
			line: `phi · baa · 1 sealed · 2 cleared · overflow till ${back}`,
			overflow: Option.some(
				`Overflow: your subscription hit its rate limit, so 2 requests ran on your BAA account. phi-router tries it again at ${back}. Add another subscription: npx phi-router accounts add`,
			),
			printed: [[silent], [silent, silent, silent], [], [silent]],
		},
	);
}).pipe(Effect.scoped);

it.layer(Layer.merge(NodeServices.layer, FetchHttpClient.layer))("the plugin's turn-end hook", (test) => {
	test.effect.each(["codex"] as const)(
		"for %s, announces a turn that sealed once, from a count kept 0600 in 0700",
		announced,
		patient,
	);
	test.effect("for codex, says no router answers when none does", () => down, patient);
	test.effect(
		"for codex, tells once that a rate-limited subscription sent a request to the BAA account, and /phi shows when it is back",
		() => overflowed,
		patient,
	);
	test.effect(
		"for claude, no hook prints to the conversation after a turn that sealed and overflowed, and the status line and /phi carry both",
		() => claudeQuiet,
		patient,
	);
});
