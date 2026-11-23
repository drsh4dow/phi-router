import { assert, it } from "@effect/vitest";
import { Digest } from "effect/crypto";
import { Effect } from "effect";
import { contentKey } from "./content-key.ts";

it.layer(Digest.layerWebCrypto)("contentKey", (test) => {
	test.effect("gives the key the original parts.ts gave the same fields", () =>
		Effect.gen(function* original() {
			const key = yield* contentKey(["tool", "isError", "false", "text", "héllo 👋"]);

			assert.strictEqual(key, "4cc96b13381c940775f9356ceff12b7fac29adaf4474a8b4f8bfb8558baa4be2");
		}),
	);

	test.effect("keeps a field's bounds, so moving text between fields changes the key", () =>
		Effect.gen(function* bounded() {
			const split = yield* contentKey(["ab", "c"]);
			const moved = yield* contentKey(["a", "bc"]);

			assert.notStrictEqual(split, moved);
		}),
	);
});
