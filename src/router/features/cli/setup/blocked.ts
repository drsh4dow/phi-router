import { Config, Effect, Option, Record, String as Str, pipe } from "effect";
import { managedEnv, userSettings } from "#router/client/harnesses/index.ts";
import { providerSwitchIn, providerSwitchOn, routerAddress } from "#router/features/cli/claude/index.ts";
import type { ProviderSwitch } from "#router/features/cli/claude/index.ts";
import { stops } from "./copy.ts";

const providerNames: Readonly<Record<ProviderSwitch, string>> = {
	CLAUDE_CODE_USE_ANTHROPIC_AWS: "CLAUDE_CODE_USE_ANTHROPIC_AWS",
	CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD: "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
	CLAUDE_CODE_USE_BEDROCK: "Bedrock",
	CLAUDE_CODE_USE_FOUNDRY: "Foundry",
	CLAUDE_CODE_USE_GATEWAY: "CLAUDE_CODE_USE_GATEWAY",
	CLAUDE_CODE_USE_MANTLE: "CLAUDE_CODE_USE_MANTLE",
	CLAUDE_CODE_USE_VERTEX: "Vertex AI",
};

const providerStop = (name: ProviderSwitch): string => stops.provider(providerNames[name]);

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

const providerIn = (env: Readonly<Record<string, string>>): Option.Option<string> =>
	pipe(providerSwitchIn(env), Option.map(providerStop));

const claudeBlocked = Effect.fnUntraced(function* claudeBlocked(os: string) {
	const managed = yield* managedEnv(os);
	const settings = yield* userSettings("");

	const shell = yield* Config.String(baseUrl).pipe(
		Config.map((url): Readonly<Record<string, string>> => ({ [baseUrl]: url })),
		Config.withDefault({}),
	);

	const switched = yield* providerSwitchOn;

	return pipe(
		providerIn(managed),
		Option.orElse(() => gatewayIn(managed, "company's ")),
		Option.orElse(() => providerIn(settings.env)),
		Option.orElse(() => gatewayIn(settings.env, "")),
		Option.orElse(() => pipe(switched, Option.map(providerStop))),
		Option.orElse(() => gatewayIn(shell, "")),
	);
});

export { claudeBlocked };
