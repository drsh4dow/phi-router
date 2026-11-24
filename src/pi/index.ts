import { Array, Config, Effect, Layer, Option, Record, String as Str, pipe } from "effect";
import type {
	BeforeProviderHeadersEvent,
	ExtensionAPI,
	ExtensionFactory,
	ExtensionHandler,
	InputEvent,
	InputEventResult,
	ModelRegistry,
	ProviderConfig,
	RegisteredCommand,
	SessionBeforeCompactEvent,
	SessionBeforeCompactResult,
	SessionManager,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import {
	answered,
	compactionSent,
	observerOn,
	phiModels,
	promptSent,
	routedProvider,
	sessionLeased,
	usage,
} from "#pi/features/phi/index.ts";
import { blockUploads, recordUse } from "#pi/features/uploads/index.ts";
import { loopback, phiCommand, productPort } from "#shared/cli.ts";
import { BunServices } from "@effect/platform-bun";
import type { ModelsJson } from "#shared/cli.ts";
import { NodeServices } from "@effect/platform-node";
import type { Observe } from "#pi/features/phi/index.ts";
import { Router } from "#pi/client/router.ts";
import { piWire } from "#shared/pi.ts";

const launcher = decodeURIComponent(new URL("../claude/bin/phi-router", import.meta.url).pathname);

const loginProvider = "anthropic";

const placeholderKey = "sk-ant-oat-phi-router";

const router = (): Layer.Layer<Router> => {
	if ("Bun" in globalThis) {
		return Layer.provide(Router.layer(launcher), BunServices.layer);
	}

	return Layer.provide(Router.layer(launcher), NodeServices.layer);
};

const provider = (served: { readonly port: number; readonly models: typeof ModelsJson.Type }): ProviderConfig => ({
	api: "anthropic-messages",
	apiKey: placeholderKey,
	baseUrl: `http://${loopback}:${String(served.port)}${piWire.base}`,
	headers: { [piWire.sessionHeader]: "" },
	models: phiModels(served.models),
});

interface HeaderContext {
	readonly modelRegistry: Pick<ModelRegistry, "getApiKeyForProvider">;
	readonly sessionManager: Pick<SessionManager, "getSessionId">;
}

type Headers = Readonly<Record<string, string | null>>;

const addedHeaders =
	(ctx: HeaderContext) =>
	(sent: Headers): Effect.Effect<Headers> =>
		Effect.gen(function* added() {
			if (!(piWire.sessionHeader in sent)) {
				return {};
			}

			const login = yield* Effect.promise(() => ctx.modelRegistry.getApiKeyForProvider(loginProvider));

			return {
				authorization: pipe(
					Option.fromNullishOr(login),
					Option.map((token) => `Bearer ${token}`),
					Option.getOrNull,
				),
				[piWire.sessionHeader]: ctx.sessionManager.getSessionId(),
			};
		});

const headed: ExtensionHandler<BeforeProviderHeadersEvent> = (event, ctx) =>
	Effect.runPromise(
		Effect.map(addedHeaders(ctx)(event.headers), (added) => {
			for (const [name, value] of Record.toEntries(added)) {
				event.headers[name] = value;
			}
		}),
	);

const leased =
	(port: number, atStart: Observe): ExtensionHandler<SessionStartEvent> =>
	(_event, ctx) =>
		Effect.runPromise(Effect.provide(sessionLeased(port)(atStart, ctx), router()));

const observed =
	<Event, Result>(observe: Observe): ExtensionHandler<Event, Result> =>
	(_event, ctx) =>
		Effect.runPromise(Effect.provide(observe(ctx), router()));

const phiAnswered: (port: number) => RegisteredCommand["handler"] = (port) => (words, ctx) =>
	Effect.runPromise(Effect.provide(answered(port)(words, ctx), router()));

const checked =
	(port: number): ExtensionHandler<InputEvent, InputEventResult> =>
	(_event, ctx) =>
		Effect.runPromise(Effect.provide(promptSent(port)(ctx), router()));

const compacted =
	(port: number): ExtensionHandler<SessionBeforeCompactEvent, SessionBeforeCompactResult> =>
	(_event, ctx) =>
		Effect.runPromise(Effect.provide(compactionSent(port)(ctx), router()));

const onRouter = (
	pi: Readonly<Pick<ExtensionAPI, "on">>,
	port: number,
	shows: { readonly afterTurn: Observe; readonly atStart: Observe },
): void => {
	pi.on("session_start", leased(port, shows.atStart));
	pi.on("input", checked(port));
	pi.on("session_before_compact", compacted(port));
	pi.on("turn_end", observed(shows.afterTurn));
	pi.on("model_select", observed(shows.atStart));
};

const bypassProxies = Effect.forEach(
	["NO_PROXY", "no_proxy"],
	(name) =>
		Effect.map(Config.String(name).pipe(Config.withDefault("")), (named) => {
			globalThis.process.env[name] = pipe([named, loopback], Array.filter(Str.isNonEmpty), Array.join(","));
		}),
	{ concurrency: 1, discard: true },
);

const configured = Effect.all(
	{
		models: Effect.orElseSucceed(
			Router.use((client) => client.models),
			() => ({}),
		),
		port: Config.Port(piWire.portVariable).pipe(Config.withDefault(productPort)),
	},
	{ concurrency: 1 },
);

const hooked = Effect.fnUntraced(function* hooked(
	pi: Readonly<Pick<ExtensionAPI, "appendEntry" | "on" | "registerCommand">>,
	port: number,
) {
	const shows = yield* observerOn(port);

	pi.on("session_start", blockUploads(routedProvider));
	onRouter(pi, port, shows);
	pi.on("before_provider_headers", recordUse({ pi, routedProvider }));
	pi.on("before_provider_headers", headed);
	pi.registerCommand(phiCommand.name, { description: usage, handler: phiAnswered(port) });
});

const extension: ExtensionFactory = (pi) =>
	Effect.runPromise(
		Effect.provide(
			Effect.gen(function* registered() {
				const { models, port } = yield* configured;

				yield* bypassProxies;
				pi.registerProvider(routedProvider, provider({ models, port }));
				yield* hooked(pi, port);
			}),
			router(),
		),
	);

export default extension;

export { addedHeaders, bypassProxies, configured, hooked, provider };
