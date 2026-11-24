import { Array, Effect, Option, Predicate, Record, Schema, String as Str, pipe } from "effect";
import { Raw } from "./wire.ts";
import { rawText } from "./json.ts";

const readCatalog = Schema.decodeUnknownOption(Schema.fromJsonString(Raw));

const readModels = Schema.decodeUnknownOption(Schema.Array(Raw));

const encodeNewerModel = Schema.encodeEffect(Schema.OptionFromNullOr(Schema.String));

const catalogWith =
	(entry: { readonly slug: string; readonly copyOf: string }) =>
	(catalog: string): Effect.Effect<Option.Option<string>> =>
		Effect.gen(function* appendTo() {
			const noNewerModel = yield* Effect.orDie(encodeNewerModel(Option.none()));

			const appended = Option.gen(function* append() {
				const raw = yield* readCatalog(catalog);
				const models = yield* readModels(raw["models"]);
				const copied = yield* Array.findFirst(models, (model) => model["slug"] === entry.copyOf);

				const added = pipe(
					copied,
					Record.set("slug", entry.slug),
					Record.set("display_name", "PHI auto"),
					Record.set("upgrade", noNewerModel),
					Record.set("visibility", "list"),
				);

				return Record.set(raw, "models", [...models, added]);
			});

			return yield* Effect.transposeOption(pipe(appended, Option.map(rawText)));
		});

const fromCodex = (headers: Readonly<Record<string, string | undefined>>): boolean =>
	Str.startsWith("codex_")(headers["originator"] ?? "");

const codexVersion = /^\d+(?:\.\d+)*(?:-(?:alpha|beta|rc)(?:\.\d+)*)?$/u;

const versionLimit = 32;

const catalogQuery = (
	query: Readonly<Record<string, string | undefined>>,
): Option.Option<Readonly<Record<string, string>>> => {
	const asked = query["client_version"];

	if (Predicate.isUndefined(asked)) {
		return Option.some({});
	}

	if (asked.length > versionLimit || !codexVersion.test(asked)) {
		return Option.none();
	}

	return Option.some({ client_version: asked });
};

export { catalogQuery, catalogWith, fromCodex };
