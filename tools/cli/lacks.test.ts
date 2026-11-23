import { Array, Effect, FileSystem, Schema, Struct } from "effect";
import { ConfigFile, leaks, phiRouter, prepared } from "./accounts-run.ts";
import { assert, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";

const succeeded = 0;

const fileOf = Effect.fnUntraced(function* fileOf(file: string) {
	const fs = yield* FileSystem.FileSystem;
	const text = yield* fs.readFileString(file);

	return yield* Schema.decodeEffect(ConfigFile)(text);
});

const listsLacks = Effect.gen(function* listsLacks() {
	const run = yield* prepared("lacking");
	const before = yield* fileOf(run.configFile);
	const added = yield* phiRouter(run.env, ["accounts", "add", run.folders.claude]);
	const listed = yield* phiRouter(run.env, ["accounts"]);
	const after = yield* fileOf(run.configFile);

	const leaked = yield* leaks(
		[run.env.XDG_CONFIG_HOME, run.env.XDG_STATE_HOME],
		[added.stdout, added.stderr, listed.stdout, listed.stderr],
	);

	assert.deepStrictEqual<unknown>(
		{ kept: Struct.omit(after, ["clean"]), leaked, listed },
		{
			kept: Struct.omit(before, ["clean"]),
			leaked: [],
			listed: {
				exitCode: succeeded,
				stderr: "",
				stdout: Array.join(
					[
						"Clean lane",
						"  claude-1      Claude  forwarded     ok.",
						"  claude-2      Claude  login folder  ok. Login ends 2100-01-01.",
						"Sealed lane",
						"  enterprise    Claude  forwarded     ok. Lacks claude-haiku-5-5, claude-sonnet-5-5.",
						"  enterprise-2  Claude  key env       ok.",
						"",
					],
					"\n",
				),
			},
		},
	);
});

it.layer(NodeServices.layer)("phi-router accounts and the models a BAA account lacks", (test) => {
	test.effect(
		"the list shows the models each BAA account lacks, and add keeps them and sealedModel in config.json",
		() => listsLacks,
		{ timeout: 60_000 },
	);
});
