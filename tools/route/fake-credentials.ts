import { Array, Effect, Record, Schema, String as Str, Struct, pipe } from "effect";

/**
 * The fake credentials of a run, and the models it names. No real account ever sees them, and no real credential is
 * read. Each vendor's sealed model differs from the target model, so a check sees which one a send names.
 */
const fakes = {
	accountId: "phi-test-account",
	baaKey: "phi-test-baa-key",
	harnessToken: "phi-test-harness-token",
	judgeKey: "phi-test-judge-key",
	sealedModel: { anthropic: "claude-sealed-model", openai: "gpt-sealed-model" },
	targetModel: "target-under-test",
} as const;

/** The one mock that may receive each fake credential. */
const owners = { baa: fakes.baaKey, judge: fakes.judgeKey, open: fakes.harnessToken } as const;

const jsonOf = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

type Mock = keyof typeof owners;

/**
 * The breaches in the text of everything `mock` received: its own credential missing, or another's present.
 *
 * @param {Mock} mock The mock.
 * @param {string} text What it received, as JSON text.
 * @returns {readonly string[]} Each breach, as the mock and whose credential, never a value.
 */
const breachesIn = (mock: Mock, text: string): readonly string[] =>
	pipe(
		Record.toEntries(owners),
		Array.flatMap(([owner, credential]) => {
			const holds = Str.includes(credential)(text);

			if (owner === mock && !holds) {
				return [`the ${mock} mock never received its own credential`];
			}

			if (owner !== mock && holds) {
				return [`the ${mock} mock received the ${owner} credential`];
			}

			return [];
		}),
	);

/** A request a mock recorded. Its headers are read by entry, since an HTTP header set prints its credentials redacted. */
interface Carried {
	readonly headers: Readonly<Record<string, string>>;
}

/**
 * The credential rule: of the run's fake credentials, a mock that received a request received its own, and no
 * mock received another's, in a header, the path, the query or the body.
 *
 * @param {object} received Every request each mock received.
 * @returns {Effect.Effect<readonly string[]>} Each breach, as the mock and whose credential, never a value.
 */
const credentialBreaches = (received: Readonly<Record<Mock, readonly Carried[]>>): Effect.Effect<readonly string[]> =>
	Effect.map(
		Effect.forEach(
			Record.toEntries(received),
			([mock, requests]) => {
				if (!Array.isReadonlyArrayNonEmpty(requests)) {
					return Effect.succeed([]);
				}

				const carried = pipe(
					requests,
					Array.map((request) => Struct.assign(request, { headers: Record.toEntries(request.headers) })),
				);

				return Effect.map(Effect.orDie(jsonOf(carried)), (text) => breachesIn(mock, text));
			},
			{ concurrency: 1 },
		),
		Array.flatten,
	);

export { credentialBreaches, fakes };
