import {
	Array,
	ConfigProvider,
	Context,
	Effect,
	FileSystem,
	Layer,
	Option,
	Path,
	Predicate,
	Struct,
	identity,
	pipe,
} from "effect";
import { FetchHttpClient, HttpClient, HttpServer } from "effect/http";
import type { Harness, Json, LaneAccount, Scripts, Sent } from "./harnesses.ts";
import type { HttpClientError, HttpClientResponse } from "effect/http";
import { LaneChoice, decide } from "#router/features/lanes/index.ts";
import { codexBodyOf, credentialBreaches, fakes, harnesses, jsonText, judgeOf, lacksOf } from "./harnesses.ts";
import { Callers } from "#router/client/router-port/index.ts";
import { NodeHttpServer } from "@effect/platform-node";
import { Router } from "#router/features/route/index.ts";
import { VerdictStore } from "#router/client/verdict-store.ts";
import { mockOn } from "#tools/judge/configured.ts";
import { writePrivately } from "#router/client/private-file.ts";

const nothingListens = Effect.scoped(
	Effect.map(Layer.build(NodeHttpServer.layerTest), (server) =>
		HttpServer.formatAddress(Context.get(server, HttpServer.HttpServer).address),
	),
);

const accountOn = Effect.fnUntraced(function* accountOn(harness: Harness, scripts: Scripts, account: LaneAccount) {
	if (account === "refused") {
		const endpoint = yield* nothingListens;
		const refused: Effect.Success<ReturnType<Harness["serve"]>> = { endpoint, received: Effect.succeed([]) };

		return refused;
	}

	if (Predicate.hasProperty(account, "endpoint")) {
		const own: Effect.Success<ReturnType<Harness["serve"]>> = {
			endpoint: account.endpoint,
			received: Effect.succeed([]),
		};

		return own;
	}

	const server = yield* Layer.build(NodeHttpServer.layerTest);

	return yield* Effect.provideContext(harness.serve(scripts, account), server);
});

const first = 0;

const oneBased = 1;

const entriesOf = (of: {
	readonly scripts: Scripts;
	readonly lane: "open" | "baa";
	readonly mocks: readonly { readonly endpoint: string }[];
}): readonly Json[] =>
	pipe(
		of.mocks,
		Array.map(({ endpoint }, index): Json => {
			const name = Option.match(
				Option.liftPredicate(index, (at) => at > first),
				{
					onNone: () => of.lane,
					onSome: (at) => `${of.lane}-${String(at + oneBased)}`,
				},
			);

			const { vendor } = harnesses[of.scripts.harness ?? "claude"];
			const named = Struct.assign({ endpoint, name, vendor }, lacksOf(of)(index));

			const folder = of.scripts[`${of.lane}Folder`];

			if (index === first && Predicate.isNotUndefined(folder)) {
				return Struct.assign(named, { loginFolder: folder });
			}

			if (of.lane === "baa") {
				return Struct.assign(named, { keyEnv: "PHI_TEST_BAA_KEY", scheme: "apiKey" });
			}

			return Struct.assign(named, { forwarded: true });
		}),
	);

const laneOn = Effect.fnUntraced(function* laneOn(harness: Harness, scripts: Scripts, lane: "open" | "baa") {
	const [account, ...rest] = scripts[`${lane}s`] ?? Array.of(scripts[lane] ?? harness.answersOk[lane]);
	const mock = yield* accountOn(harness, scripts, account);
	const others = yield* Effect.forEach(rest, (other) => accountOn(harness, scripts, other), { concurrency: 1 });
	const mocks = Array.prepend(others, mock);

	return { entries: entriesOf({ lane, mocks, scripts }), mocks };
});

const configured = Effect.fnUntraced(function* configured(
	vendor: Harness["vendor"],
	lanes: {
		readonly clean: readonly Json[];
		readonly sealed: readonly Json[];
		readonly judgeEndpoint: string;
	},
	beside: Scripts["configExtras"],
) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const config = yield* fs.makeTempDirectoryScoped({ prefix: "phi-router-config-" });
	const state = yield* fs.makeTempDirectoryScoped({ prefix: "phi-router-state-" });

	const file = yield* jsonText(
		Struct.assign(
			Struct.assign({ judge: { endpoint: lanes.judgeEndpoint, keyEnv: "PHI_TEST_JUDGE_KEY" } }, beside ?? {}),
			{
				clean: lanes.clean,
				sealed: lanes.sealed,
				targetModel: { [vendor]: fakes.targetModel },
			},
		),
	);

	yield* writePrivately(path.join(config, "phi-router", "config.json"), file);

	const env = {
		PHI_TEST_BAA_KEY: fakes.baaKey,
		PHI_TEST_JUDGE_KEY: fakes.judgeKey,
		XDG_CONFIG_HOME: config,
		XDG_STATE_HOME: state,
	};

	return { env, roots: [state, config], state: path.join(state, "phi-router") };
});

const mocked = Effect.fnUntraced(function* mocked(scripts: Scripts) {
	const harness = harnesses[scripts.harness ?? "claude"];
	const opens = yield* laneOn(harness, scripts, "open");
	const baas = yield* laneOn(harness, scripts, "baa");
	const judge = yield* mockOn(judgeOf(scripts));
	const [open] = opens.mocks;
	const [baa] = baas.mocks;

	const { env, roots, state } = yield* configured(
		harness.vendor,
		{
			clean: opens.entries,
			judgeEndpoint: judge.endpoint,
			sealed: baas.entries,
		},
		scripts.configExtras,
	);

	const breaches = Effect.all(
		{ baa: baa.received, judge: judge.received, open: open.received },
		{ concurrency: 1 },
	).pipe(Effect.flatMap(credentialBreaches));

	const mocks = {
		accounts: Effect.forEach([...opens.mocks, ...baas.mocks], (mock) => mock.received, { concurrency: 1 }),
		baa,
		baas: baas.mocks,
		judge,
		open,
		opens: opens.mocks,
	};

	return {
		breaches,
		env: Struct.assign(scripts.routerEnv ?? {}, env),
		harness,
		mocks,
		received: Effect.all([open.received, baa.received, judge.received], { concurrency: 1 }),
		roots,
		state,
	};
});

interface Turn {
	readonly role: "user" | "assistant";
	readonly text: string;
}

const bodyOf = Effect.fnUntraced(function* bodyOf(turns: readonly Turn[]) {
	const messages = pipe(
		turns,
		Array.map(({ role, text }) => ({ content: [{ text, type: "text" }], role })),
	);

	return yield* jsonText({ max_tokens: 1024, messages, model: "phi/auto", stream: true });
});

const routed = Effect.fnUntraced(function* routed(
	scripts: Scripts & {
		readonly choice?: typeof LaneChoice.Service;
		readonly callers?: typeof Callers.Service;
		readonly store?: (real: VerdictStore["Service"]) => VerdictStore["Service"];
		readonly fetch?: typeof globalThis.fetch;
	},
) {
	const { breaches, env, harness, mocks, state } = yield* mocked(scripts);

	const provided = Layer.mergeAll(
		ConfigProvider.layer(ConfigProvider.fromEnv({ env })),
		Layer.succeed(LaneChoice, scripts.choice ?? decide),
		Layer.succeed(FetchHttpClient.Fetch, scripts.fetch ?? globalThis.fetch),
	);

	const callers = Option.match(Option.fromNullishOr(scripts.callers), {
		onNone: () => Callers.layer,
		onSome: (replaced) => Layer.succeed(Callers, replaced),
	});

	const served = Router([]).pipe(
		Layer.provideMerge(NodeHttpServer.layerTest),
		Layer.updateService(VerdictStore, scripts.store ?? identity),
		Layer.provide(VerdictStore.layer),
		Layer.provide(callers),
		Layer.provide(provided),
	);

	const built = yield* Layer.build(served);
	const client = Context.get(built, HttpClient.HttpClient);

	const post = (sent: Sent): Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError> =>
		client.execute(harness.request(sent));

	const url = HttpServer.formatAddress(Context.get(built, HttpServer.HttpServer).address);

	return { breaches, client, env, mocks, post, state, url };
});

type Post = Effect.Success<ReturnType<typeof routed>>["post"];

const postedIn = Effect.fnUntraced(function* postedIn(post: Post, session: string, input: readonly Json[]) {
	const body = yield* codexBodyOf(input);
	const response = yield* post({ body, session });

	yield* response.text;

	return response.status;
});

export { beta, claudeRequest, fakes, harnesses } from "./harnesses.ts";

export { bodyOf, mocked, postedIn, routed };

export { laneLines } from "./lane-lines.ts";

export type { Post, Turn };

export type { LaneLogLine } from "./lane-lines.ts";

export type { Said, Sent as Received } from "#router/client/mock-upstreams/index.ts";
