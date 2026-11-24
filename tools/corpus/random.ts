import { Array, Number as Num, Option, pipe } from "effect";
import { or, shiftRight, unsigned32, xor } from "./encodings.ts";

interface Random {
	readonly int: (bound: number) => number;
	readonly between: (low: number, high: number) => number;
	readonly chance: (probability: number) => boolean;
	readonly pick: <Item>(items: Array.NonEmptyReadonlyArray<Item>) => Item;
	readonly shuffle: <Item>(items: readonly Item[]) => Item[];
	readonly chars: (alphabet: string, count: number) => string;
	readonly digits: (count: number) => string;
	readonly hex: (count: number) => string;
}

interface Planted {
	readonly has: (value: string) => boolean;
	readonly add: (value: string) => void;
}

const mulberry = {
	masks: { first: 1, second: 61 },
	shifts: { first: 15, second: 7, third: 14 },
	step: 1_831_565_813,
} as const;

const wordValues = 4_294_967_296;

const mix = (state: number): number => {
	const spread = xor(state, shiftRight(state, mulberry.shifts.first));
	const mixed = unsigned32(Math.imul(spread, or(state, mulberry.masks.first)));
	const respread = xor(mixed, shiftRight(mixed, mulberry.shifts.second));
	const scrambled = Math.imul(respread, or(mixed, mulberry.masks.second));
	const remixed = xor(unsigned32(mixed + scrambled), mixed);

	return xor(remixed, shiftRight(remixed, mulberry.shifts.third));
};

const mulberry32 = (seed: number): (() => number) => {
	let state = unsigned32(seed);

	return () => {
		state = unsigned32(state + mulberry.step);

		return mix(state) / wordValues;
	};
};

const seeded = (seed: number): Random => {
	const float = mulberry32(seed);

	const int = (bound: number): number => Math.floor(float() * bound);

	const pick = <Item>(items: Array.NonEmptyReadonlyArray<Item>): Item => Array.getUnsafe(items, int(items.length));

	const shuffle = <Item>(items: readonly Item[]): Item[] => {
		const shuffled = Array.copy(items);
		const indices = Array.fromIterable(shuffled.keys());
		const swapped = Option.getOrElse(Array.tail(indices), Array.empty);

		for (const index of Array.reverse(swapped)) {
			const other = int(Num.increment(index));
			const there = Array.getUnsafe(shuffled, other);

			shuffled[other] = Array.getUnsafe(shuffled, index);
			shuffled[index] = there;
		}

		return shuffled;
	};

	const chars = (alphabet: string, count: number): string =>
		pipe(
			Array.makeBy(count, () => alphabet[int(alphabet.length)] ?? ""),
			Array.join(""),
		);

	return {
		between: (low, high) => low + int(Num.increment(high - low)),
		chance: (probability) => float() < probability,
		chars,
		digits: (count) => chars("0123456789", count),
		hex: (count) => chars("0123456789abcdef", count),
		int,
		pick,
		shuffle,
	};
};

const unique = ({ used, draw }: { readonly used: Planted; readonly draw: () => string }): string => {
	let value = draw();

	while (used.has(value)) {
		value = draw();
	}

	used.add(value);

	return value;
};

export { seeded, unique };

export type { Planted, Random };
