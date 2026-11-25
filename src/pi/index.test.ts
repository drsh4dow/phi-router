import { Array, Config, ConfigProvider, Effect, Function, Option, Record, pipe } from "effect";
import { CommandFailed, productPort } from "#shared/cli.ts";
import { addedHeaders, provider, registered } from "#pi/index.ts";
import { assert, it, vi } from "@effect/vitest";
import type { ModelsJson } from "#shared/cli.ts";
import { Router } from "#pi/client/router.ts";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";

const session = "pi-session-1";

const login = "pi-login-token";

const loginOf = (named: string): Promise<string> => {
	if (named === "anthropic") {
		return Promise.resolve(login);
	}

	return Promise.resolve("pi-openai-key");
};

const added = addedHeaders({
	modelRegistry: { getApiKeyForProvider: loginOf },
	sessionManager: { getSessionId: (): string => session },
});

it.effect("gives a request of the provider phi its session and pi's Anthropic login", () =>
	Effect.gen(function* phiRequest() {
		const marked = provider({ models: {}, port: productPort }).headers ?? {};
		const headers = yield* added(Record.set(marked, "x-other", "kept"));

		assert.deepStrictEqual(headers, { authorization: `Bearer ${login}`, "x-phi-session": session });
	}),
);

it.effect("adds nothing to a request of another provider, so it goes out as pi built it", () =>
	Effect.gen(function* otherRequest() {
		const headers = yield* added({ authorization: "Bearer other-provider-key", "x-other": "kept" });

		assert.deepStrictEqual(headers, {});
	}),
);

interface Listed {
	readonly id: string;
	readonly contextWindow?: number | undefined;
	readonly maxTokens?: number | undefined;
}

const listed = ({ contextWindow, id, maxTokens }: Listed): Listed => ({ contextWindow, id, maxTokens });

it.effect(
	"offers phi's own models and each Anthropic model of pi's catalog, with the limits the catalog gives it",
	() =>
		Effect.sync(() => {
			const offered = pipe(
				Option.fromNullishOr(provider({ models: {}, port: productPort }).models),
				Option.map(Array.map(listed)),
			);

			const catalog = pipe(getBuiltinModels("anthropic"), Array.map(listed));

			const ids = pipe(
				catalog,
				Array.map(({ id }) => id),
			);

			assert.deepStrictEqual(
				offered,
				Option.some([
					{ contextWindow: 200_000, id: "auto", maxTokens: 32_000 },
					{ contextWindow: 200_000, id: "sealed", maxTokens: 32_000 },
					...catalog,
				]),
			);
			assert.includeMembers(ids, ["claude-opus-5-5", "claude-fable-5-2"]);
		}),
);

const ownModels = ["auto", "sealed"];

it.effect("gives auto and sealed the catalog's limits of the models config.json names, and 200K and 32K past it", () =>
	Effect.sync(() => {
		const [named = { contextWindow: 0, id: "", maxTokens: 0 }] = getBuiltinModels("anthropic");
		const anthropic = { auto: named.id, sealed: "not-in-the-catalog" };
		const offered = provider({ models: { anthropic }, port: productPort }).models ?? [];

		const own = pipe(
			offered,
			Array.filter(({ id }) => Array.contains(ownModels, id)),
			Array.map(listed),
		);

		assert.deepStrictEqual(own, [
			{ contextWindow: named.contextWindow, id: "auto", maxTokens: named.maxTokens },
			{ contextWindow: 200_000, id: "sealed", maxTokens: 32_000 },
		]);
	}),
);

const routerPort = 47_497;

const routed = { anthropic: { auto: "claude-auto", sealed: "claude-baa" } };

const routerOf = (printed: { readonly models?: typeof ModelsJson.Type }): Router["Service"] =>
	Router.of({
		models: Effect.mapError(Effect.fromNullishOr(printed.models), () =>
			CommandFailed.make({ cause: "refused", command: "models" }),
		),
		setUp: () => Effect.die("registering sets nothing up"),
		setupStep: () => Effect.die("registering sets nothing up"),
		start: () => Effect.void,
		status: () => Effect.die("registering asks no status"),
	});

const answers = routerOf({ models: routed });

const refuses = routerOf({});

const registeredOn = Effect.fnUntraced(function* registeredOn(environment: Readonly<Record<string, string>>) {
	const hooks: string[] = [];
	const registerProvider = vi.fn<(...registration: readonly unknown[]) => void>();

	const pi = {
		appendEntry: Function.constVoid,
		on: (event: string): (() => void) => {
			hooks.push(`on ${event}`);

			return Function.constVoid;
		},
		registerCommand: (name: string): void => {
			hooks.push(`command ${name}`);
		},
		registerProvider,
		setModel: (): Promise<boolean> => Promise.resolve(false),
	};

	yield* Effect.provideService(registered(pi), ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(environment));

	return { hooks, providers: registerProvider.mock.calls };
});

it.effect(
	"runs on the port PHI_ROUTER_PORT names with the models phi-router models prints, else the product port with none",
	() =>
		Effect.gen(function* ports() {
			const named = yield* Effect.provideService(
				registeredOn({ PHI_ROUTER_PORT: String(routerPort) }),
				Router,
				answers,
			);

			const unnamed = yield* Effect.provideService(registeredOn({}), Router, refuses);

			assert.deepStrictEqual(
				{ named: named.providers, unnamed: unnamed.providers },
				{
					named: [["phi", provider({ models: routed, port: routerPort })]],
					unnamed: [["phi", provider({ models: {}, port: productPort })]],
				},
			);
		}),
);

it.effect("keeps the router's address off any proxy pi's process names, beside the hosts already there", () =>
	Effect.gen(function* proxies() {
		yield* Effect.provideService(registeredOn({ NO_PROXY: "localhost" }), Router, refuses);

		const bypassed = yield* Config.all({ lower: Config.String("no_proxy"), upper: Config.String("NO_PROXY") });

		assert.deepStrictEqual(bypassed, { lower: "127.0.0.1", upper: "localhost,127.0.0.1" });
	}),
);

it.effect("adds /phi and hooks each session's start, prompts, compactions, turns, model switches and headers", () =>
	Effect.gen(function* hookedOnPi() {
		const { hooks } = yield* Effect.provideService(registeredOn({}), Router, refuses);

		assert.deepStrictEqual(hooks, [
			"on session_start",
			"on session_start",
			"on input",
			"on session_before_compact",
			"on turn_end",
			"on model_select",
			"on before_provider_headers",
			"on before_provider_headers",
			"command phi",
		]);
	}),
);
