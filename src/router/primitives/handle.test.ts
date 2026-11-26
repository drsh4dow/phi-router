import { Array, Effect, Option, Schema, pipe } from "effect";
import { Handle, handleAt, opened, stubTag } from "./handle.ts";
import { assert, describe, it } from "@effect/vitest";

const storedSequence = 2;

const contentOf = (handle: typeof Handle.Type): Option.Option<string> =>
	Option.liftPredicate(`part ${handle}`, () => handle === handleAt(storedSequence));

const shown = "[content of h2]\npart h2\n[end of h2]";

const first = 1;

const twelfth = 12;

const third = 3;

const named = Effect.sync(() => {
	const isHandle = Schema.is(Handle);

	assert.deepStrictEqual([handleAt(first), handleAt(twelfth), stubTag(handleAt(third))], ["h1", "h12", "[sealed h3]"]);
	assert.deepStrictEqual(
		pipe(
			["h1", "h40", "h0", "h01", "H1", "h1a", "h-1"],
			Array.map((text) => isHandle(text)),
		),
		[true, true, false, false, false, false, false],
	);
});

const opensAtEdges = Effect.sync(() => {
	assert.deepStrictEqual(
		pipe(
			[
				"Redact [sealed h2] and list the claim ids.",
				"Read h2.",
				"Read h2, then h2: list (h2)",
				"Read h9 and [sealed h9]",
			],
			Array.map((text) => opened(contentOf)(text)),
		),
		[
			`Redact ${shown} and list the claim ids.`,
			`Read ${shown}.`,
			`Read ${shown}, then ${shown}: list (${shown})`,
			"Read h9 and [sealed h9]",
		],
	);
});

const staysInsideWords = Effect.sync(() => {
	const untouched = ["<h2>Title</h2>", "sh2 h2x h2_b h2-b", "/srv/h2/notes", "notes.h2", "h2.txt", "h02 H2"];

	assert.deepStrictEqual(
		pipe(
			untouched,
			Array.map((text) => opened(contentOf)(text)),
		),
		untouched,
	);
});

describe("a handle", () => {
	it.effect("is h and the part's sequence number in its session, and nothing else", () => named);

	it.effect(
		"opens in its stub form and bare, at a word's edge, with the part's content put in its place",
		() => opensAtEdges,
	);

	it.effect("does not open inside a word, a tag, a path or a file name", () => staysInsideWords);
});
