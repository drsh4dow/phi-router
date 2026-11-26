import { Array, Effect, Option, pipe } from "effect";
import { assert, it } from "@effect/vitest";
import { versionNote } from "./claude.ts";

const printed = [
	"2.1.331 (Claude Code)",
	"1.9.400 (Claude Code)",
	"2.1.332 (Claude Code)",
	"2.2.0 (Claude Code)",
	"10.0.0",
	"claude",
];

it.effect(
	"doctor notes a Claude Code older than 2.1.332 by its version, and nothing for 2.1.332, a later one or output it cannot read",
	() =>
		Effect.sync(() => {
			const noted = pipe(printed, Array.map(versionNote));
			const [older = Option.none()] = noted;

			assert.deepStrictEqual(pipe(noted, Array.map(Option.isSome)), [true, true, false, false, false, false]);
			assert.include(
				Option.getOrElse(older, () => ""),
				"Claude Code 2.1.331 is older than 2.1.332",
			);
		}),
);
