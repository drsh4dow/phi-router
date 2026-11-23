import { Effect, FileSystem, String as Str } from "effect";
import { assert, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import { ran } from "#tools/lifecycle/launched.ts";

const patient = { timeout: 60_000 };

const checkout = Str.replace(/\/$/u, "")(new URL("../..", import.meta.url).pathname);

const stale = "is not the build of this tree. Run `bun run build` and commit the bundle.";

const bundles = ["claude/phi-router.mjs", "pi/extension.mjs"];

const fresh = Effect.gen(function* fresh() {
	const fs = yield* FileSystem.FileSystem;
	const folder = yield* fs.makeTempDirectoryScoped({ prefix: "phi-bundle-" });
	const build = yield* ran(["bun", `${checkout}/tools/plugin/build.ts`, folder], {});

	for (const bundle of bundles) {
		const built = yield* fs.readFileString(`${folder}/${bundle}`);
		const committed = yield* fs.readFileString(`${checkout}/plugins/${bundle}`);

		assert.isTrue(built === committed, `plugins/${bundle} ${stale} The build printed: ${build.printed}`);
		assert.notInclude(committed, checkout);
	}
}).pipe(Effect.scoped);

it.layer(NodeServices.layer)("the plugins' bundles", (test) => {
	test.effect("are the build of this tree, and hold no absolute path of the checkout", () => fresh, patient);
});
