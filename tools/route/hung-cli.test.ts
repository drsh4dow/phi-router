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

/** More ticks than the 30-second refresh limit and the kill deadline after it take together. */
const ticks = 120;

const patient = { timeout: 60_000 };

const token = "phi-test-hung-token";

const body =
	'{"max_tokens":1024,"messages":[{"content":[{"text":"Go on.","type":"text"}],"role":"user"}],"model":"phi/auto","stream":true}';

/** A stand-in `claude` that marks that it started, ignores SIGTERM and never exits, and never writes the folder. */
const hung = Array.join(
	["#!/bin/sh", ': > "$(dirname "$0")/started"', "trap '' TERM", "while :; do sleep 1; done", ""],
	"\n",
);

const waiting = { schedule: Schedule.spaced("20 millis"), times: 250 } as const;

/** A Claude login folder whose token expires in a minute of the test clock, and the stand-in on `PATH`. */
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

/** Waits, on the real clock, until the stand-in in `bin` has started. */
const started = Effect.fnUntraced(function* started(bin: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;

	yield* fs.exists(path.join(bin, "started")).pipe(
		Effect.filterOrFail((marked) => marked),
		Effect.retry(waiting),
		TestClock.withLive,
	);
});

/** Moves the test clock a second at a time, with a real pause between, then fails: the request outlived every tick. */
const ticking = Effect.andThen(
	Effect.forEach(
		Array.replicate(tick, ticks),
		(each) => Effect.andThen(TestClock.adjust(each), TestClock.withLive(Effect.sleep(pause))),
		{ concurrency: 1, discard: true },
	),
	Effect.fail("the request still waits after every tick"),
);

/**
 * A token a minute from expiry runs the vendor CLI, and that CLI ignores SIGTERM and never exits. Once the refresh limit
 * passes, the router kills it, finds the token still near expiry, and fails over to the BAA account, so the request
 * ends. The clock moves only once the CLI runs, so it cannot outrun the router's check of the caller before it.
 */
const boundedByLimit = Effect.gen(function* boundedByLimit() {
	yield* TestClock.setTime(start);

	const login = yield* nearExpiry;

	const { mocks, post } = yield* routed({
		env: { PATH: `${login.bin}:/usr/bin:/bin` },
		holdsPhi: () => false,
		openFolder: login.folder,
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

/** The harness hangs up while the home account's vendor CLI runs, and the request's line still names that account. */
const hungUpInRefresh = Effect.gen(function* hungUpInRefresh() {
	yield* TestClock.setTime(start);

	const login = yield* nearExpiry;

	const { post, state } = yield* routed({
		env: { PATH: `${login.bin}:/usr/bin:/bin` },
		holdsPhi: () => false,
		openFolder: login.folder,
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
		"whose vendor CLI ignores SIGTERM and never exits fails over once the refresh limit passes",
		() => boundedByLimit,
		patient,
	);
	test.effect(
		"whose vendor CLI runs when the harness hangs up leaves the request's line naming it",
		() => hungUpInRefresh,
		patient,
	);
});
