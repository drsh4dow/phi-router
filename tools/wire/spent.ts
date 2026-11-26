import { Array, Option, Record, Schema, String as Str, pipe } from "effect";

interface Tokens {
	readonly uncachedInput: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly output: number;
}

type Usage = { readonly read: true; readonly tokens: Tokens } | { readonly read: false };

const counted = Schema.optionalKey(Schema.NullOr(Schema.Finite));

const AnthropicUsage = Schema.Struct({
	cache_creation_input_tokens: counted,
	cache_read_input_tokens: counted,
	input_tokens: counted,
	output_tokens: counted,
});

const Cached = Schema.Struct({ cached_tokens: Schema.Finite });

const OpenAiUsage = Schema.Struct({
	input_tokens: Schema.Finite,
	input_tokens_details: Schema.optionalKey(Cached),
	output_tokens: Schema.Finite,
});

const MessageStart = Schema.Struct({
	message: Schema.Struct({ usage: AnthropicUsage }),
	type: Schema.Literal("message_start"),
});

const MessageDelta = Schema.Struct({ type: Schema.Literals(["message_delta", "message"]), usage: AnthropicUsage });

const ResponseCompleted = Schema.Struct({
	response: Schema.Struct({ usage: OpenAiUsage }),
	type: Schema.Literal("response.completed"),
});

const WholeResponse = Schema.Struct({ object: Schema.Literal("response"), usage: OpenAiUsage });

const decodeStarted = Schema.decodeOption(Schema.fromJsonString(MessageStart));

const decodeAnthropic = Schema.decodeOption(Schema.fromJsonString(MessageDelta));

const decodeCompleted = Schema.decodeOption(Schema.fromJsonString(ResponseCompleted));

const decodeResponse = Schema.decodeOption(Schema.fromJsonString(WholeResponse));

const anthropicCounted = (usage: typeof AnthropicUsage.Type): Partial<Tokens> =>
	Record.getSomes({
		cacheRead: Option.fromNullishOr(usage.cache_read_input_tokens),
		cacheWrite: Option.fromNullishOr(usage.cache_creation_input_tokens),
		output: Option.fromNullishOr(usage.output_tokens),
		uncachedInput: Option.fromNullishOr(usage.input_tokens),
	});

const uncached = 0;

const openAiCounted = (usage: typeof OpenAiUsage.Type): Tokens => {
	const cached = pipe(
		Option.fromUndefinedOr(usage.input_tokens_details),
		Option.match({ onNone: () => uncached, onSome: ({ cached_tokens: tokens }) => tokens }),
	);

	return { cacheRead: cached, cacheWrite: 0, output: usage.output_tokens, uncachedInput: usage.input_tokens - cached };
};

const countedIn = (piece: string): Option.Option<Partial<Tokens>> =>
	Option.firstSomeOf([
		Option.map(decodeStarted(piece), ({ message }) => anthropicCounted(message.usage)),
		Option.map(decodeAnthropic(piece), ({ usage }) => anthropicCounted(usage)),
		Option.map(decodeCompleted(piece), ({ response }) => openAiCounted(response.usage)),
		Option.map(decodeResponse(piece), ({ usage }) => openAiCounted(usage)),
	]);

const absent = 0;

const lastOf =
	(all: readonly Partial<Tokens>[]) =>
	(kind: keyof Tokens): number =>
		pipe(
			all,
			Array.map((counts) => Option.fromUndefinedOr(counts[kind])),
			Array.getSomes,
			Array.last,
			Option.getOrElse(() => absent),
		);

const dataLine = /^data: ?/u;

const usageIn = (answer: string): Usage =>
	pipe(
		Str.split(answer, "\n"),
		Array.map(Str.replace(dataLine, "")),
		Array.prepend(answer),
		Array.map(countedIn),
		Array.getSomes,
		Array.match({
			onEmpty: (): Usage => ({ read: false }),
			onNonEmpty: (all): Usage => {
				const last = lastOf(all);

				return {
					read: true,
					tokens: {
						cacheRead: last("cacheRead"),
						cacheWrite: last("cacheWrite"),
						output: last("output"),
						uncachedInput: last("uncachedInput"),
					},
				};
			},
		}),
	);

const dollarsPerMillionTokens = {
	"claude-haiku-5-5": { cacheRead: 0.01, cacheWrite: 0.125, output: 0.5, uncachedInput: 0.1 },
	"gpt-6-luna": { cacheRead: 0.01, cacheWrite: 0.125, output: 0.5, uncachedInput: 0.1 },
} satisfies Record<string, Tokens>;

const perMillion = 1_000_000;

const costOf = ({ model, tokens }: { readonly model: string; readonly tokens: Tokens }): Option.Option<number> =>
	Option.map(
		pipe(
			Record.toEntries(dollarsPerMillionTokens),
			Array.findFirst(([name]) => name === model),
		),
		([, price]) =>
			(tokens.uncachedInput * price.uncachedInput +
				tokens.cacheRead * price.cacheRead +
				tokens.cacheWrite * price.cacheWrite +
				tokens.output * price.output) /
			perMillion,
	);

export { costOf, usageIn };

export type { Usage };
