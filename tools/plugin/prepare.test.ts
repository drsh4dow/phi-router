import { Effect, FileSystem, Schema } from "effect";
import { assert, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import { ran } from "#tools/lifecycle/launched.ts";

const manifest = new URL("../../package.json", import.meta.url).pathname;

const Manifest = Schema.fromJsonString(Schema.Struct({ scripts: Schema.Struct({ prepare: Schema.String }) }));

/**
 * The manifest's `prepare` as npm runs it in the folder `pi install` clones into, which holds no dev tools, with an
 * `effect-tsgo` of another package first on `PATH`, as `bun run` and an ancestor's `node_modules/.bin` put one there.
 */
const prepared = Effect.gen(function* prepared() {
	const fs = yield* FileSystem.FileSystem;
	const installed = yield* fs.makeTempDirectoryScoped({ prefix: "phi-pi-installed-" });
	const otherTools = yield* fs.makeTempDirectoryScoped({ prefix: "phi-other-tools-" });
	const text = yield* fs.readFileString(manifest);
	const { scripts } = yield* Schema.decodeEffect(Manifest)(text);

	yield* fs.writeFileString(
		`${otherTools}/effect-tsgo`,
		"#!/bin/sh\necho another package's effect-tsgo ran\nexit 1\n",
		{
			mode: 0o755,
		},
	);

	const run = yield* ran(["sh", "-c", `cd "$0" && ${scripts.prepare}`, installed], {
		PATH: `${otherTools}:/usr/bin:/bin`,
	});

	assert.deepStrictEqual(run, { exitCode: 0, printed: "" });
}).pipe(Effect.scoped);

it.layer(NodeServices.layer)("the package's prepare", (test) => {
	test.effect("does nothing in an install without dev tools, whatever effect-tsgo is on PATH", () => prepared);
});
