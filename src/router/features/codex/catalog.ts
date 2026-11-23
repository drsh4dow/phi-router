import { Array, Effect, Option, Predicate, Record, Schema, String as Str, pipe } from "effect";
import { Raw } from "./wire.ts";
import { rawText } from "./json.ts";

const readCatalog = Schema.decodeUnknownOption(Schema.fromJsonString(Raw));

const readModels = Schema.decodeUnknownOption(Schema.Array(Raw));

/** The catalog's `upgrade`, JSON `null` for a model that names no newer one. */
const encodeUpgrade = Schema.encodeEffect(Schema.OptionFromNullOr(Schema.String));

/**
 * An account's model catalog, `{"models":[...]}`, with one entry appended: a copy of the entry whose `slug` is
 * `copyOf`, with `slug`, `display_name`, no `upgrade` and `visibility: "list"`. Every other entry
 * and field passes as sent.
 *
 * @param {object} entry The new entry's slug, and the slug it copies.
 * @returns {(catalog: string) => Effect.Effect<Option.Option<string>>} The catalog's JSON text with the entry, or none
 *   when the text is not a catalog or lists no `copyOf`.
 */
const catalogWith =
	(entry: { readonly slug: string; readonly copyOf: string }) =>
	(catalog: string): Effect.Effect<Option.Option<string>> =>
		Effect.gen(function* appendTo() {
			const noUpgrade = yield* Effect.orDie(encodeUpgrade(Option.none()));

			const appended = Option.gen(function* append() {
				const raw = yield* readCatalog(catalog);
				const models = yield* readModels(raw["models"]);
				const copied = yield* Array.findFirst(models, (model) => model["slug"] === entry.copyOf);

				const added = pipe(
					copied,
					Record.set("slug", entry.slug),
					Record.set("display_name", "PHI auto"),
					Record.set("upgrade", noUpgrade),
					Record.set("visibility", "list"),
				);

				return Record.set(raw, "models", [...models, added]);
			});

			return yield* Effect.transposeOption(pipe(appended, Option.map(rawText)));
		});

/**
 * Whether a request came from Codex, which names itself in `originator`: `codex_cli_rs` from `codex` and `codex_exec`
 * from `codex exec` (measured, 0.166.0). Claude Code asks `GET /v1/models` with no `originator` (measured, 2.1.325), and
 * its login must never reach an OpenAI account.
 *
 * @param {Readonly<Record<string, string | undefined>>} headers The request's headers.
 * @returns {boolean} Whether its `originator` starts with `codex_`.
 */
const fromCodex = (headers: Readonly<Record<string, string | undefined>>): boolean =>
	Str.startsWith("codex_")(headers["originator"] ?? "");

/** A Codex version as 0.166.0 sends it in `client_version`, or a pre-release such as `0.43.0-alpha.4` (npm, 2026-11-21). */
const codexVersion = /^\d+(?:\.\d+)*(?:-(?:alpha|beta|rc)(?:\.\d+)*)?$/u;

const versionLimit = 32;

/**
 * The query the model catalog is asked with: Codex's `client_version` when it has the shape of a version, so no
 * caller text reaches an open account's URL. None when it has another shape.
 *
 * @param {Readonly<Record<string, string | undefined>>} query The request's query parameters.
 * @returns {Option.Option<Readonly<Record<string, string>>>} The query to forward, or none to refuse the request.
 */
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
