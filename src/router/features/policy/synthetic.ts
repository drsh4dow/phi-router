import { Array, Context, Order, RegExp as Patterns, String as Str, pipe } from "effect";
import { syntheticIdentities, syntheticMark } from "./policy.ts";
import type { SyntheticIdentities } from "./policy.ts";

const Synthetic = Context.Reference<SyntheticIdentities>("phi-router/router/features/policy/Synthetic", {
	defaultValue: () => ({ exact: [], prefixes: [] }),
});

const notWord = String.raw`(?<![\p{L}\p{N}_])`;

const longestFirst = Order.mapInput(Order.Number, (value: string) => -value.length);

const blankerOf = (added: SyntheticIdentities): ((text: string) => string) => {
	const exact = Array.sort([...syntheticIdentities.exact, ...added.exact], longestFirst);
	const prefixes = [...syntheticIdentities.prefixes, ...added.prefixes];

	const exactly = pipe(
		exact,
		Array.map((value) => String.raw`${notWord}${Patterns.escape(value)}(?![\p{L}\p{N}_])`),
	);

	const prefixed = pipe(
		prefixes,
		Array.map((prefix) => String.raw`${notWord}${Patterns.escape(prefix)}[\p{L}\p{N}_.@+-]*`),
	);

	const listed = [...exactly, ...prefixed];

	if (Array.isArrayEmpty(listed)) {
		return (text: string) => text;
	}

	return Str.replaceAll(new RegExp(Array.join(listed, "|"), "gu"), syntheticMark);
};

export { Synthetic, blankerOf };
