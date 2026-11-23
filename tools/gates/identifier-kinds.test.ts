import { Array, Effect, FileSystem, Path } from "effect";
import { assert, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import { identifierKindNames } from "#router/features/policy/index.ts";

it.layer(NodeServices.layer)("the identifier-kind rule", (test) => {
	test.effect("matches exactly the policy's identifier kinds, in the policy's order", () =>
		Effect.gen(function* listed() {
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;

			const rule = yield* fs.readFileString(
				path.join(import.meta.dirname, "../ast-grep/rules/identifier-kinds.yml"),
			);

			assert.include(rule, `regex: "^(${Array.join(identifierKindNames, "|")})$"`);
		}),
	);
});
