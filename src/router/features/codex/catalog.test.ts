import { Effect, Option, Schema, pipe } from "effect";
import { assert, it } from "@effect/vitest";
import { catalogQuery, catalogWith, fromCodex } from "./index.ts";

const Entry = Schema.Struct({
	context_window: Schema.Finite,
	display_name: Schema.String,
	slug: Schema.String,
	upgrade: Schema.OptionFromNullOr(Schema.String),
	visibility: Schema.String,
});

const Models = Schema.Array(Schema.Json);

const Catalog = Schema.fromJsonString(Schema.Struct({ etag: Schema.String, models: Models }));

const Appended = Schema.fromJsonString(
	Schema.Struct({ etag: Schema.String, models: Schema.Tuple([Schema.Json, Schema.Json, Entry]) }),
);

const target = {
	context_window: 272_000,
	display_name: "Luna",
	slug: "gpt-6-luna",
	upgrade: "gpt-7",
	visibility: "hide",
};

const other = { display_name: "Other", slug: "gpt-5.5" };

const withAuto = catalogWith({ copyOf: "gpt-6-luna", slug: "phi/auto" });

const catalog = Schema.encodeEffect(Catalog)({ etag: "v1", models: [other, target] });

const appended = Effect.gen(function* appended() {
	const text = yield* pipe(catalog, Effect.flatMap(withAuto));
	const read = yield* Effect.flatMap(Effect.fromOption(text), Schema.decodeEffect(Appended));

	const added = {
		context_window: target.context_window,
		display_name: "PHI auto",
		slug: "phi/auto",
		upgrade: Option.none(),
		visibility: "list",
	};

	assert.deepStrictEqual(read, { etag: "v1", models: [other, target, added] });
});

const refused = Effect.gen(function* refused() {
	const missing = yield* pipe(catalog, Effect.flatMap(catalogWith({ copyOf: "gpt-9", slug: "phi/auto" })));
	const notCatalog = yield* withAuto('{"data":[]}');
	const notJson = yield* withAuto("<html>");

	assert.deepStrictEqual([missing, notCatalog, notJson], [Option.none(), Option.none(), Option.none()]);
});

it.effect(
	"the catalog gets phi/auto as a copy of the target's entry, every other entry and field as sent",
	() => appended,
);

it.effect("a catalog that lists no target, or text that is no catalog, gives none", () => refused);

const originators = Effect.sync(() => {
	assert.deepStrictEqual(
		[fromCodex({ originator: "codex_cli_rs" }), fromCodex({ originator: "codex_exec" }), fromCodex({})],
		[true, true, false],
	);
});

const unversioned = Effect.sync(() => {
	assert.deepStrictEqual(catalogQuery({}), Option.some({}));
});

it.effect(
	"a request is from Codex when its originator is codex_cli_rs or codex_exec, and not when it names none",
	() => originators,
);

it.effect("a catalog request with no client_version is asked with no query", () => unversioned);
