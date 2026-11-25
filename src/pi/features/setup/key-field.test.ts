import { Array, Effect, Function, Option, Redacted, String as Str, pipe } from "effect";
import type { KeyField, Typed } from "./key-field.ts";
import { assert, it } from "@effect/vitest";
import { keyField } from "./key-field.ts";

const key = "sk-ant-api03-secret-tail99";

const wide = 80;

const narrow = 12;

interface Opened {
	readonly field: KeyField;
	readonly given: readonly Typed[];
}

const fieldOf = (): Opened => {
	const given: Typed[] = [];

	const field = keyField({
		done: (typed) => {
			given.push(typed);
		},
		prompt: "Anthropic key (BAA):",
		theme: { fg: (_color, text) => text },
		tui: { requestRender: Function.constVoid },
	});

	return { field, given };
};

const keyLine = (lines: readonly string[]): Option.Option<string> => Array.findFirst(lines, Str.startsWith("> "));

const handedOver = (given: readonly Typed[]): readonly string[] =>
	pipe(
		given,
		Array.map((typed) => {
			if (typed.kind === "typed") {
				return Redacted.value(typed.key);
			}

			return "ended";
		}),
	);

it.effect("shows a typed key as stars with at most its last 6 characters, at any width", () =>
	Effect.sync(() => {
		const { field } = fieldOf();

		field.handleInput(key);

		const lines = pipe([wide, narrow], Array.flatMap(field.render));

		assert.deepStrictEqual(keyLine(field.render(wide)), Option.some("> ********************tail99"));
		assert.deepStrictEqual(keyLine(field.render(narrow)), Option.some("> ****tail99"));
		const shownSecret = pipe(lines, Array.some(Str.includes("secret")));

		assert.isFalse(shownSecret);
		assert.include(lines, " Anthropic key (BAA):");
	}),
);

it.effect("hands over the trimmed key on Enter, ignores an empty Enter, and ends on Escape", () =>
	Effect.sync(() => {
		const typed = fieldOf();

		typed.field.handleInput("  ");
		typed.field.handleInput("\r");
		assert.deepStrictEqual(typed.given, []);

		typed.field.handleInput(`${key} `);
		typed.field.handleInput("\r");
		assert.deepStrictEqual(handedOver(typed.given), [key]);

		const escaped = fieldOf();

		escaped.field.handleInput("\u001B");
		assert.deepStrictEqual(handedOver(escaped.given), ["ended"]);
	}),
);
