import { Array, Number as Num, Option, Record, Schema, String as Str, pipe } from "effect";

interface Tokens {
	readonly uncachedInput: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly output: number;
}

const summed = (all: readonly Tokens[]): Tokens => ({
	cacheRead: Num.sumAll(
		pipe(
			all,
			Array.map(({ cacheRead }) => cacheRead),
		),
	),
	cacheWrite: Num.sumAll(
		pipe(
			all,
			Array.map(({ cacheWrite }) => cacheWrite),
		),
	),
	output: Num.sumAll(
		pipe(
			all,
			Array.map(({ output }) => output),
		),
	),
	uncachedInput: Num.sumAll(
		pipe(
			all,
			Array.map(({ uncachedInput }) => uncachedInput),
		),
	),
});

const ClaudeUsage = Schema.Struct({
	cache_creation_input_tokens: Schema.Finite,
	cache_read_input_tokens: Schema.Finite,
	input_tokens: Schema.Finite,
	output_tokens: Schema.Finite,
});

const ClaudeResult = Schema.fromJsonString(Schema.Struct({ usage: ClaudeUsage }));

const CodexUsage = Schema.Struct({
	cached_input_tokens: Schema.Finite,
	input_tokens: Schema.Finite,
	output_tokens: Schema.Finite,
});

const CodexTurnCompleted = Schema.fromJsonString(
	Schema.Struct({ type: Schema.Literal("turn.completed"), usage: CodexUsage }),
);

const PiUsage = Schema.Struct({
	cacheRead: Schema.Finite,
	cacheWrite: Schema.Finite,
	input: Schema.Finite,
	output: Schema.Finite,
});

const PiAssistant = Schema.Struct({ role: Schema.Literal("assistant"), usage: PiUsage });

const PiMessageEnd = Schema.fromJsonString(
	Schema.Struct({ message: PiAssistant, type: Schema.Literal("message_end") }),
);

const decodedLines =
	<Line>(decode: (line: string) => Option.Option<Line>) =>
	(printed: string): readonly Line[] =>
		pipe(Str.split(printed, "\n"), Array.map(decode), Array.getSomes);

const decodeClaude = decodedLines(Schema.decodeOption(ClaudeResult));

const decodeCodex = decodedLines(Schema.decodeOption(CodexTurnCompleted));

const decodePi = decodedLines(Schema.decodeOption(PiMessageEnd));

const tokensIn = {
	claude: (printed: string): Tokens =>
		pipe(
			decodeClaude(printed),
			Array.map(({ usage }) => ({
				cacheRead: usage.cache_read_input_tokens,
				cacheWrite: usage.cache_creation_input_tokens,
				output: usage.output_tokens,
				uncachedInput: usage.input_tokens,
			})),
			summed,
		),
	codex: (printed: string): Tokens =>
		pipe(
			decodeCodex(printed),
			Array.map(({ usage }) => ({
				cacheRead: usage.cached_input_tokens,
				cacheWrite: 0,
				output: usage.output_tokens,
				uncachedInput: usage.input_tokens - usage.cached_input_tokens,
			})),
			summed,
		),
	pi: (printed: string): Tokens =>
		pipe(
			decodePi(printed),
			Array.map(({ message: { usage } }) => ({
				cacheRead: usage.cacheRead,
				cacheWrite: usage.cacheWrite,
				output: usage.output,
				uncachedInput: usage.input,
			})),
			summed,
		),
} as const;

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

export { costOf, tokensIn };

export type { Tokens };
