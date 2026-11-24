import { Array, Effect, Option, pipe } from "effect";
import { addedHeaders, provider } from "#pi/index.ts";
import { assert, it } from "@effect/vitest";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { productPort } from "#shared/cli.ts";

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
		const headers = yield* added({ "x-other": "kept", "x-phi-session": "" });

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
