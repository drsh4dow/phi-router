import { Array, Effect, Fiber, FileSystem, Path, Schedule, pipe } from "effect";
import { assert, it } from "@effect/vitest";
import { laneLines, routed } from "./mocked-router.ts";
import { NodeServices } from "@effect/platform-node";
import { TestClock } from "effect/testing";

const start = 1_780_000_000_000;

const minute = 60_000;

const tenDays = 864_000_000;

const executable = 0o755;

const ok = 200;

const tick = "1 second" as const;

const pause = "20 millis";

const patient = { timeout: 60_000 };

const token = "phi-test-hung-token";

const body =
	'{"max_tokens":1024,"messages":[{"content":[{"text":"Go on.","type":"text"}],"role":"user"}],"model":"phi/auto","stream":true}';

const hung = Array.join(
	["#!/bin/sh", ': > "$(dirname "$0")/started"', "trap '' TERM", "while :; do sleep 1; done", ""],
	"\n",
);

const waiting = { schedule: Schedule.spaced("20 millis") } as const;

const nearExpiry = Effect.gen(function* nearExpiry() {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const folder = yield* fs.makeTempDirectoryScoped({ prefix: "phi-router-login-" });
	const bin = yield* fs.makeTempDirectoryScoped({ prefix: "phi-router-bin-" });

	yield* fs.writeFileString(
		path.join(folder, ".credentials.json"),
		`{"claudeAiOauth":{"accessToken":"${token}","expiresAt":${String(start + minute)},"refreshTokenExpiresAt":${String(start + tenDays)}}}`,
	);
	yield* fs.writeFileString(path.join(bin, "claude"), hung, { mode: executable });

	return { bin, folder };
});

const started = Effect.fnUntraced(function* started(bin: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;

	yield* fs.exists(path.join(bin, "started")).pipe(
		Effect.filterOrFail((marked) => marked),
		Effect.retry(waiting),
		TestClock.withLive,
	);
});

const paused = TestClock.withLive(Effect.sleep(pause));

const ticking = Effect.forever(Effect.andThen(TestClock.adjust(tick), paused));

const boundedByLimit = Effect.gen(function* boundedByLimit() {
	yield* TestClock.setTime(start);

	const login = yield* nearExpiry;

	const { mocks, post } = yield* routed({
		holdsPhi: () => false,
		openFolder: login.folder,
		routerEnv: { PATH: `${login.bin}:/usr/bin:/bin` },
	});

	const request = yield* Effect.forkChild(
		post({ body, session: "hung-cli" }).pipe(Effect.flatMap((response) => Effect.as(response.text, response.status))),
	);

	yield* started(login.bin);

	const status = yield* Effect.raceFirst(Fiber.join(request), ticking);
	const [opened = [], sealed = []] = yield* mocks.accounts;

	assert.deepStrictEqual(
		{ opened: opened.length, sealed: sealed.length, status },
		{ opened: 0, sealed: 1, status: ok },
	);
});

const hungUpInRefresh = Effect.gen(function* hungUpInRefresh() {
	yield* TestClock.setTime(start);

	const login = yield* nearExpiry;

	const { post, state } = yield* routed({
		holdsPhi: () => false,
		openFolder: login.folder,
		routerEnv: { PATH: `${login.bin}:/usr/bin:/bin` },
	});

	const request = yield* Effect.forkChild(post({ body, session: "hung-up-in-refresh" }));

	yield* started(login.bin);
	yield* Fiber.interrupt(request);

	const lines = yield* laneLines(state).pipe(
		Effect.filterOrFail(Array.isReadonlyArrayNonEmpty),
		Effect.retry(waiting),
		TestClock.withLive,
	);

	assert.deepStrictEqual(
		pipe(
			lines,
			Array.map(({ account, lane, reason }) => [account, lane, reason]),
		),
		[["open", "clean", "clean"]],
	);
});

it.layer(NodeServices.layer)("a login-folder account", (test) => {
	test.effect(
		"whose vendor CLI ignores SIGTERM and never exits has it killed once the refresh limit passes, and the request fails over to the BAA account",
		() => boundedByLimit,
		patient,
	);
	test.effect(
		"whose vendor CLI runs when the harness hangs up leaves the request's line naming it",
		() => hungUpInRefresh,
		patient,
	);
});
