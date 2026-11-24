import { Array, Effect, Record, Schema, String as Str, Struct, pipe } from "effect";

const fakes = {
	accountId: "phi-test-account",
	baaKey: "phi-test-baa-key",
	harnessToken: "phi-test-harness-token",
	judgeKey: "phi-test-judge-key",
	sealedModel: { anthropic: "claude-sealed-model", openai: "gpt-sealed-model" },
	targetModel: "target-under-test",
} as const;

const ownCredentials = { baa: fakes.baaKey, judge: fakes.judgeKey, open: fakes.harnessToken } as const;

const jsonOf = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

type Mock = keyof typeof ownCredentials;

const breachesIn = (mock: Mock, text: string): readonly string[] =>
	pipe(
		Record.toEntries(ownCredentials),
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

interface RecordedRequest {
	readonly headers: Readonly<Record<string, string>>;
}

const credentialBreaches = (
	received: Readonly<Record<Mock, readonly RecordedRequest[]>>,
): Effect.Effect<readonly string[]> =>
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
