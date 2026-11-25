import { Array, Config, Effect, Option, Record, String as Str, pipe } from "effect";

const providerSwitches = [
	"CLAUDE_CODE_USE_BEDROCK",
	"CLAUDE_CODE_USE_VERTEX",
	"CLAUDE_CODE_USE_FOUNDRY",
	"CLAUDE_CODE_USE_ANTHROPIC_AWS",
	"CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
	"CLAUDE_CODE_USE_MANTLE",
	"CLAUDE_CODE_USE_GATEWAY",
] as const;

type ProviderSwitch = (typeof providerSwitches)[number];

const onValues = ["1", "true", "yes", "on"];

const isOn = (value: string): boolean => Array.contains(onValues, Str.toLowerCase(Str.trim(value)));

const providerSwitchIn = (env: Readonly<Record<string, string>>): Option.Option<ProviderSwitch> =>
	pipe(
		providerSwitches,
		Array.findFirst((name) => Option.exists(Record.get(env, name), isOn)),
	);

const providerSwitchOn = Effect.gen(function* providerSwitchOn() {
	const values = yield* Effect.forEach(
		providerSwitches,
		(name) => Effect.map(Config.String(name).pipe(Config.withDefault("")), (value) => [name, value] as const),
		{ concurrency: 1 },
	);

	return providerSwitchIn(Record.fromEntries(values));
});

export { providerSwitchIn, providerSwitchOn };

export type { ProviderSwitch };
