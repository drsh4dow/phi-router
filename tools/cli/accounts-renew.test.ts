import { Clock, Effect, FileSystem, Path, String as Str } from "effect";
import { assert, it } from "@effect/vitest";
import { claudeCredentials, phiRouter, prepared } from "./accounts-run.ts";
import { NodeServices } from "@effect/platform-node";
import { TestClock } from "effect/testing";

const patient = { timeout: 60_000 };

const endsIn = { threeDays: 216_000_000, underADay: 43_200_000 };

const claudeLine = 2;

const listsRenewal = Effect.gen(function* listsRenewal() {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const run = yield* prepared("claudeOnly");
	const fix = `CLAUDE_CONFIG_DIR=${run.folders.claude} claude auth login`;

	yield* phiRouter(run.env, ["accounts", "add", run.folders.claude]);

	const listed = yield* Effect.forEach(
		[endsIn.threeDays, endsIn.underADay],
		(span) =>
			TestClock.withLive(Clock.currentTimeMillis).pipe(
				Effect.flatMap((now) =>
					fs.writeFileString(path.join(run.folders.claude, ".credentials.json"), claudeCredentials(now + span)),
				),
				Effect.andThen(phiRouter(run.env, ["accounts"])),
				Effect.map(({ stdout }) => Str.split(stdout, "\n")[claudeLine]),
			),
		{ concurrency: 1 },
	);

	assert.deepStrictEqual(listed, [
		`  claude-2    Claude  login folder  Login ends in 3 days. Renew: ${fix}`,
		`  claude-2    Claude  login folder  Login ends in under a day. Renew: ${fix}`,
	]);
});

it.layer(NodeServices.layer)("phi-router accounts", (test) => {
	test.effect("the list carries the renew command for a login that ends within 3 days", () => listsRenewal, patient);
});
