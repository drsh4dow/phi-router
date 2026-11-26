import { Option, Schema } from "effect";
import { assert, describe, it } from "@effect/vitest";
import { Handle, handleAt, opened, stubTag } from "./handle.ts";

const contentOf = (handle: typeof Handle.Type): Option.Option<string> =>
	Option.liftPredicate(`part ${handle}`, () => handle === handleAt(2));

const shown = "[content of h2]\npart h2\n[end of h2]";

describe("a handle", () => {
	it("is h and the part's sequence number in its session, and nothing else", () => {
		const isHandle = Schema.is(Handle);

		assert.deepStrictEqual([handleAt(1), handleAt(12), stubTag(handleAt(3))], ["h1", "h12", "[sealed h3]"]);
		assert.deepStrictEqual(
			["h1", "h40", "h0", "h01", "H1", "h1a", "h-1"].map((text) => isHandle(text)),
			[true, true, false, false, false, false, false],
		);
	});

	it("opens in its stub form and bare, at a word's edge, with the part's content put in its place", () => {
		assert.deepStrictEqual(
			[
				"Redact [sealed h2] and list the claim ids.",
				"Read h2.",
				"Read h2, then h2: list (h2)",
				"Read h9 and [sealed h9]",
			].map((text) => opened(contentOf)(text)),
			[
				`Redact ${shown} and list the claim ids.`,
				`Read ${shown}.`,
				`Read ${shown}, then ${shown}: list (${shown})`,
				"Read h9 and [sealed h9]",
			],
		);
	});

	it("does not open inside a word, a tag, a path or a file name", () => {
		const untouched = ["<h2>Title</h2>", "sh2 h2x h2_b h2-b", "/srv/h2/notes", "notes.h2", "h2.txt", "h02 H2"];

		assert.deepStrictEqual(
			untouched.map((text) => opened(contentOf)(text)),
			untouched,
		);
	});
});
