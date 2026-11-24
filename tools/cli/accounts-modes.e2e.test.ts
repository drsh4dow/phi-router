import { Effect, FileSystem, String as Str } from "effect";
import { assert, it } from "@effect/vitest";
import { phiRouter, prepared } from "./accounts-run.ts";
import { NodeServices } from "@effect/platform-node";
import { privacyUnder } from "#tools/route/private.ts";

const patient = { timeout: 60_000 };

const succeeded = 0;

const shared = 0o755;

/** A config folder the user made at 0755 keeps its mode after an add, and `config.json` in it is 0600. */
const writesPrivately = Effect.gen(function* writesPrivately() {
	const fs = yield* FileSystem.FileSystem;
	const run = yield* prepared("both");
	const folder = Str.replace(/\/config\.json$/u, "")(run.configFile);

	yield* fs.chmod(folder, shared);

	const added = yield* phiRouter(run.env, ["accounts", "add", run.folders.claude]);
	const { notPrivate } = yield* privacyUnder([run.env.XDG_CONFIG_HOME]);

	assert.deepStrictEqual(
		{ exitCode: added.exitCode, notPrivate },
		{ exitCode: succeeded, notPrivate: [`${folder} 755`] },
	);
});

it.layer(NodeServices.layer)("phi-router accounts add", (test) => {
	test.effect(
		"leaves config.json 0600 and a config folder it found at the mode it had",
		() => writesPrivately,
		patient,
	);
});
