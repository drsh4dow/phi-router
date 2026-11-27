import { Array, Effect, Option, String as Str, pipe } from "effect";
import { assert, it } from "@effect/vitest";
import { endsWithExemption, exemptionLine, holdsExemption, sealedRole, withoutExemption } from "./settings.ts";
import { pinnedLine } from "#router/features/lanes/index.ts";
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

it.effect.each([
	{ end: "\n", name: "LF" },
	{ end: "\r\n", name: "CRLF" },
])("finds the proxy exemption in a .env with $name line ends, and takes it out keeping the other lines", ({ end }) =>
	Effect.sync(() => {
		const dotenv = `A=1${end}${exemptionLine}${end}`;

		assert.deepStrictEqual(
			{ ends: endsWithExemption(dotenv), held: holdsExemption(dotenv), without: withoutExemption(dotenv) },
			{ ends: true, held: true, without: Option.some(`A=1${end}`) },
		);
	}),
);
