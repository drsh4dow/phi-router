import { Array, Config, Effect, Option, Record, String as Str, pipe } from "effect";
import { managedEnv, userSettings } from "#router/client/harnesses/index.ts";
import { routerAddress } from "#router/features/cli/claude/index.ts";
import { stops } from "./copy.ts";

const switchedOn: ReadonlySet<string> = new Set(["1", "true", "yes", "on"]);

const providerSwitches = {
	CLAUDE_CODE_USE_BEDROCK: "Bedrock",
	CLAUDE_CODE_USE_FOUNDRY: "Foundry",
	CLAUDE_CODE_USE_VERTEX: "Vertex AI",
} as const;

const baseUrl = "ANTHROPIC_BASE_URL";

const hostPattern = /^[a-z]+:\/\/(?:[^/@]*@)?(?<host>[^/:@]+)/iu;

const hostOf = (address: string): string =>
	pipe(
		Option.fromNullishOr(hostPattern.exec(address)),
		Option.flatMap(({ groups }) => Option.fromNullishOr(groups)),
		Option.flatMap(({ host }) => Option.fromNullishOr(host)),
		Option.getOrElse(() => baseUrl),
	);

const gatewayIn = (env: Readonly<Record<string, string>>, whose: string): Option.Option<string> =>
	pipe(
		Record.get(env, baseUrl),
		Option.filter(Str.isNonEmpty),
		Option.filter((address) => address !== routerAddress),
		Option.map((address) => stops.gateway(hostOf(address), whose)),
	);

const isOn = (value: string): boolean => switchedOn.has(Str.toLowerCase(Str.trim(value)));

const providerIn = (env: Readonly<Record<string, string>>): Option.Option<string> =>
	pipe(
		Record.toEntries(providerSwitches),
		Array.findFirst(([name]) => Option.exists(Record.get(env, name), isOn)),
		Option.map(([, provider]) => stops.provider(provider)),
	);

const claudeBlocked = Effect.fnUntraced(function* claudeBlocked(os: string) {
	const managed = yield* managedEnv(os);
	const settings = yield* userSettings("");

	const shell = yield* Config.String(baseUrl).pipe(
		Config.map((url): Readonly<Record<string, string>> => ({ [baseUrl]: url })),
		Config.withDefault({}),
	);

	return pipe(
		providerIn(managed),
		Option.orElse(() => gatewayIn(managed, "company's ")),
		Option.orElse(() => gatewayIn(settings.env, "")),
		Option.orElse(() => gatewayIn(shell, "")),
	);
});

export { claudeBlocked };
