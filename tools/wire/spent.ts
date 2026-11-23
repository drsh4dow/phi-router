import { Array, Number as Num, Option, Record, Schema, String as Str, pipe } from "effect";

/** Tokens one harness turn spent, by how its model bills them. `input` holds no cached token. */
interface Tokens {
	readonly input: number;
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
	input: Num.sumAll(
		pipe(
			all,
			Array.map(({ input }) => input),
		),
	),
	output: Num.sumAll(
		pipe(
			all,
			Array.map(({ output }) => output),
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

/**
 * The tokens a turn spent, from what each harness prints in its machine output: the result object of `claude -p
 * --output-format json`, the `turn.completed` events of `codex exec --json`, whose input count holds the cached tokens,
 * and the assistant `message_end` events of `pi --mode json`.
 */
const tokensIn = {
	claude: (printed: string): Tokens =>
		pipe(
			decodeClaude(printed),
			Array.map(({ usage }) => ({
				cacheRead: usage.cache_read_input_tokens,
				cacheWrite: usage.cache_creation_input_tokens,
				input: usage.input_tokens,
				output: usage.output_tokens,
			})),
			summed,
		),
	codex: (printed: string): Tokens =>
		pipe(
			decodeCodex(printed),
			Array.map(({ usage }) => ({
				cacheRead: usage.cached_input_tokens,
				cacheWrite: 0,
				input: usage.input_tokens - usage.cached_input_tokens,
				output: usage.output_tokens,
			})),
			summed,
		),
	pi: (printed: string): Tokens =>
		pipe(
			decodePi(printed),
			Array.map(({ message }) => message.usage),
			summed,
		),
} as const;

/** US dollars per million tokens of each model a BAA account may run in the live run, as pi 1.6.0's catalog lists them. */
const prices = {
	"claude-haiku-5-5": { cacheRead: 0.01, cacheWrite: 0.125, input: 0.1, output: 0.5 },
	"gpt-6-luna": { cacheRead: 0.01, cacheWrite: 0.125, input: 0.1, output: 0.5 },
} satisfies Record<string, Tokens>;

const perMillion = 1_000_000;

/**
 * What a turn's tokens cost on the model a BAA account ran, or none when the live run knows no price for it.
 *
 * @param {object} spent The model and the tokens.
 * @param {string} spent.model The model the BAA account ran.
 * @param {Tokens} spent.tokens The tokens the turn spent.
 * @returns {Option.Option<number>} The cost in US dollars.
 */
const costOf = ({ model, tokens }: { readonly model: string; readonly tokens: Tokens }): Option.Option<number> =>
	Option.map(
		pipe(
			Record.toEntries(prices),
			Array.findFirst(([name]) => name === model),
		),
		([, price]) =>
			(tokens.input * price.input +
				tokens.cacheRead * price.cacheRead +
				tokens.cacheWrite * price.cacheWrite +
				tokens.output * price.output) /
			perMillion,
	);

export { costOf, tokensIn };

export type { Tokens };
