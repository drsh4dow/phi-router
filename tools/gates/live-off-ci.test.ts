import { Array, Effect, FileSystem, Path, Schema, String as Str, pipe } from "effect";
import { assert, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";

/** What would start a paid or real-account run: the skill, its driver, the live eval, the wire runs and their scripts. */
const liveCommands = [
	"verify-router",
	"live.sh",
	"eval:live",
	"--judge live",
	"run wire",
	"wire/run.ts",
	"wire:accounts",
	"wire/accounts.ts",
];

const Scripts = Schema.fromJsonString(
	Schema.Struct({ scripts: Schema.Struct({ check: Schema.String, test: Schema.String }) }),
);

it.layer(NodeServices.layer)("CI", (test) => {
	test.effect("runs no live command, in its workflow or in the scripts `bun run check` runs", () =>
		Effect.gen(function* offline() {
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;
			const root = path.join(import.meta.dirname, "../..");
			const workflow = yield* fs.readFileString(path.join(root, ".github/workflows/check.yml"));
			const manifest = yield* fs.readFileString(path.join(root, "package.json"));
			const { scripts } = yield* Schema.decodeEffect(Scripts)(manifest);

			const ran = [workflow, scripts.check, scripts.test];

			const found = pipe(
				liveCommands,
				Array.filter((command) => pipe(ran, Array.some(Str.includes(command)))),
			);

			assert.include(workflow, "bun run check");
			assert.deepStrictEqual(found, []);
		}),
	);
});
