import { Array, Effect, FileSystem, Order, String as Str } from "effect";
import { assert, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import { bundles } from "./bundles.ts";
import { filePath } from "#tools/file-path.ts";

const checkout = Str.replace(/\/$/u, "")(filePath(new URL("../..", import.meta.url)));

const portable = Effect.gen(function* portable() {
	const fs = yield* FileSystem.FileSystem;

	for (const { out } of bundles) {
		const built = yield* fs.readFileString(`${checkout}/${out}`);

		assert.notInclude(built, checkout, out);
	}
});

const piPackagesImported = Effect.gen(function* piPackagesImported() {
	const fs = yield* FileSystem.FileSystem;
	const built = yield* fs.readFileString(`${checkout}/plugins/pi/extension.mjs`);
	const found = Str.matchAll(/from"(?<from>@earendil-works\/[^"]+)"/gu)(built);
	const imported = Array.map(Array.fromIterable(found), ([, from = ""]) => from);

	assert.deepStrictEqual(Array.sort(imported, Order.String), [
		"@earendil-works/pi-ai/providers/all",
		"@earendil-works/pi-coding-agent",
		"@earendil-works/pi-tui",
	]);
});

it.layer(NodeServices.layer)("the plugins' bundles", (test) => {
	test.effect("hold no absolute path of the checkout", () => portable);
	test.effect("leave pi's own packages to the pi that loads the extension", () => piPackagesImported);
});
