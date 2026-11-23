import { Effect, FileSystem, String as Str } from "effect";
import { assert, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import { bundles } from "./bundles.ts";

const checkout = Str.replace(/\/$/u, "")(new URL("../..", import.meta.url).pathname);

const portable = Effect.gen(function* portable() {
	const fs = yield* FileSystem.FileSystem;

	for (const { out } of bundles) {
		const built = yield* fs.readFileString(`${checkout}/${out}`);

		assert.notInclude(built, checkout, out);
	}
});

it.layer(NodeServices.layer)("the plugins' bundles", (test) => {
	test.effect("hold no absolute path of the checkout", () => portable);
});
