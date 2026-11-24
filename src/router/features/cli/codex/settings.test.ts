import { Array, Effect, Option, String as Str, pipe } from "effect";
import { assert, it } from "@effect/vitest";
import { pinnedLine } from "#router/features/lanes/index.ts";
import { sealedRole } from "./settings.ts";
import { statementsOf } from "#router/primitives/toml.ts";

it.effect("the pinned subagent's role keeps the pinned line out of the description each main agent sees", () =>
	Effect.sync(() => {
		const description = pipe(
			statementsOf(sealedRole),
			Array.findFirst(({ path }) => Array.join(path, ".") === "description"),
		);

		assert.isTrue(
			Option.exists(description, ({ value }) => !Str.includes(pinnedLine)(value)),
			sealedRole,
		);
	}),
);
