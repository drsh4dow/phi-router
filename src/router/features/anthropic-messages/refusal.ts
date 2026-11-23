import { Array, Option, Schema, pipe } from "effect";
import { forwarded, isForwarded } from "./wire.ts";
import { itemsOf, textOf } from "./spans.ts";
import type { ForwardedKey } from "./wire.ts";
import type { Span } from "./spans.ts";

/**
 * The clean lane cannot take this request, so it goes to the sealed lane with the bytes Claude Code sent: a member the
 * clean lane would carry onto a stub, such as a `cache_control`, is outside its recorded shape. `reason` is its path.
 */
class CleanLaneRefused extends Schema.TaggedError<CleanLaneRefused, { readonly brand: unique symbol }>()(
	"CleanLaneRefused",
	{ reason: Schema.String },
) {}

/**
 * Whether a member's text is in its recorded shape, with no member the shape does not name.
 *
 * @param {ForwardedKey} key The member's name.
 * @param {string} text Its value as sent.
 * @returns {boolean} Whether the clean lane may carry it.
 */
const fits = (key: ForwardedKey, text: string): boolean => {
	const decode = Schema.decodeOption(Schema.fromJsonString(forwarded[key]));

	return Option.isSome(decode(text, { onExcessProperty: "error" }));
};

/**
 * Each object the clean lane may carry members out of, by path: a system block, a message, its blocks and a tool
 * result's blocks. Read from the scan, so the blocks of a message the parse could not name are checked too.
 *
 * @param {Span} body The body.
 * @returns {readonly (readonly [string, Span])[]} The objects and their paths.
 */
const carriersOf = (body: Span): readonly (readonly [string, Span])[] => {
	const withBlocks = (path: string, object: Span): readonly (readonly [string, Span])[] => [
		[path, object],
		...pipe(
			itemsOf("content")(object),
			Array.flatMap((block, index) => withBlocks(`${path}.content[${String(index)}]`, block)),
		),
	];

	return [
		...pipe(
			itemsOf("system")(body),
			Array.map((block, index) => [`system[${String(index)}]`, block] as const),
		),
		...pipe(
			itemsOf("messages")(body),
			Array.flatMap((message, index) => withBlocks(`messages[${String(index)}]`, message)),
		),
	];
};

/**
 * The path of each member the clean lane would carry whose value is outside its shape.
 *
 * @param {Span} body The body.
 * @returns {readonly string[]} The paths, never the values.
 */
const refusalsOf = (body: Span): readonly string[] =>
	pipe(
		carriersOf(body),
		Array.flatMap(([path, object]) =>
			pipe(
				object.members,
				Array.filter((member) => isForwarded(member.key) && !fits(member.key, textOf(member.value))),
				Array.map((member) => `${path}.${member.key}`),
			),
		),
	);

export { CleanLaneRefused, refusalsOf };
