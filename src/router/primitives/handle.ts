import { Array, Option, Schema, String as Str, pipe } from "effect";

const Handle = Schema.String.check(Schema.isPattern(/^h[1-9]\d*$/u)).pipe(Schema.brand("Handle"));

const handleAt = (sequence: number): typeof Handle.Type => Handle.make(`h${String(sequence)}`);

const stubTag = (handle: typeof Handle.Type): string => `[sealed ${handle}]`;

const named =
	/\[sealed (?<stubbed>h[1-9]\d*)\]|(?<![\p{L}\p{N}_\-./\\<])(?<bare>h[1-9]\d*)(?![\p{L}\p{N}_\-/\\>]|\.[\p{L}\p{N}_])/gu;

const handleOf = Schema.decodeUnknownOption(Handle);

const textStart = 0;

const opened =
	(contentOf: (handle: typeof Handle.Type) => Option.Option<string>) =>
	(text: string): string => {
		const [end, pieces] = Array.mapAccum(Array.fromIterable(Str.matchAll(named)(text)), textStart, (at, match) => {
			const [whole, stubbed, bare] = match;
			const start = match.index ?? at;

			const shown = pipe(
				handleOf(stubbed ?? bare),
				Option.flatMap((handle) =>
					Option.map(contentOf(handle), (content) => `[content of ${handle}]\n${content}\n[end of ${handle}]`),
				),
				Option.getOrElse(() => whole),
			);

			return [start + whole.length, `${Str.slice(at, start)(text)}${shown}`];
		});

		return `${Array.join(pieces, "")}${Str.slice(end)(text)}`;
	};

export { Handle, handleAt, opened, stubTag };
