import { Array, Effect, Option } from "effect";
import { assert, it } from "@effect/vitest";
import { installFailure } from "./install.ts";

const failed = 1;

const succeeded = 0;

it.effect("an installer that exits non-zero stops setup with its output, and one that exits 0 does not", () =>
	Effect.sync(() => {
		const failures = Array.map([failed, succeeded], (exitCode) =>
			installFailure({ name: "claude", turn: { exitCode, kind: "exited", printed: "marketplace not found" } }),
		);

		assert.deepStrictEqual(failures, [
			Option.some("The install in Claude Code failed:\nmarketplace not found"),
			Option.none(),
		]);
	}),
);
