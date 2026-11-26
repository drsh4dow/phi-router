import type {
	AgentBeforeSettleEvent,
	AgentBeforeSettleEventResult,
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
import { Array, Config, DateTime, Effect, Layer, Option, Record, String as Str, pipe } from "effect";
import {
	answerChecked,
	answered,
	compactionSent,
	phiModels,
	promptSent,
	sessionLeased,
	sessionOf,
	statusShown,
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
import { setUp } from "#pi/features/setup/index.ts";

const launcher = decodeURIComponent(new URL("../claude/bin/phi-router", import.meta.url).pathname);

const loginProvider = "anthropic";

const placeholderKey = "sk-ant-oat-phi-router";

const router = (): Layer.Layer<Router | DateTime.CurrentTimeZone> => {
	if ("Bun" in globalThis) {
		return Layer.merge(Layer.provide(Router.layer(launcher), BunServices.layer), DateTime.layerCurrentZoneLocal);
	}

	return Layer.merge(Layer.provide(Router.layer(launcher), NodeServices.layer), DateTime.layerCurrentZoneLocal);
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
			const session = yield* sessionOf(ctx);

			return {
				authorization: pipe(
					Option.fromNullishOr(login),
					Option.map((token) => `Bearer ${token}`),
					Option.getOrNull,
				),
				[piWire.sessionHeader]: session,
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

const phiAnswered =
	(port: number, pi: Pick<ExtensionAPI, "setModel">): RegisteredCommand["handler"] =>
	(words, ctx) => {
		if (Str.trim(words) === phiCommand.setup) {
			return Effect.runPromise(Effect.provide(setUp({ pi, port })(ctx), router()));
		}

		return Effect.runPromise(Effect.provide(answered(port)(words, ctx), router()));
	};

const checked =
	(port: number): ExtensionHandler<InputEvent, InputEventResult> =>
	(_event, ctx) =>
		Effect.runPromise(Effect.provide(promptSent(port)(ctx), router()));

const settling =
	(port: number): ExtensionHandler<AgentBeforeSettleEvent, AgentBeforeSettleEventResult> =>
	(event, ctx) => {
		const settled = Effect.map(
			answerChecked(port)(event, ctx),
			Option.match({
				onNone: () => event,
				onSome: ({ continues, entry }) => ({ continue: continues, entries: [...event.entries, entry] }),
			}),
		);

		return Effect.runPromise(Effect.provide(settled, router()));
	};

const compacted =
	(port: number): ExtensionHandler<SessionBeforeCompactEvent, SessionBeforeCompactResult> =>
	(_event, ctx) =>
		Effect.runPromise(Effect.provide(compactionSent(port)(ctx), router()));

const onRouter = (pi: Readonly<Pick<ExtensionAPI, "on">>, port: number): void => {
	const shown = statusShown(port);

	pi.on("session_start", leased(port, shown));
	pi.on("input", checked(port));
	pi.on("session_before_compact", compacted(port));
	pi.on("agent_before_settle", settling(port));
	pi.on("turn_end", observed(shown));
	pi.on("model_select", observed(shown));
};

const bypassProxies = Effect.forEach(
	["NO_PROXY", "no_proxy"],
	(name) =>
		Effect.map(Config.String(name).pipe(Config.withDefault("")), (named) => {
			globalThis.process.env[name] = pipe([named, loopback], Array.filter(Str.isNonEmpty), Array.join(","));
		}),
	{ concurrency: 1, discard: true },
);

const registered = Effect.fnUntraced(function* registered(
	pi: Readonly<Pick<ExtensionAPI, "appendEntry" | "on" | "registerCommand" | "registerProvider" | "setModel">>,
) {
	const models = yield* Effect.orElseSucceed(
		Router.use((client) => client.models),
		() => ({}),
	);

	const port = yield* Config.Port(piWire.portVariable).pipe(Config.withDefault(productPort));

	yield* bypassProxies;
	pi.registerProvider(piWire.provider, provider({ models, port }));
	pi.on("session_start", blockUploads(piWire.provider));
	onRouter(pi, port);
	pi.on("before_provider_headers", recordUse({ pi, routedProvider: piWire.provider }));
	pi.on("before_provider_headers", headed);
	pi.registerCommand(phiCommand.name, { description: usage, handler: phiAnswered(port, pi) });
});

const extension: ExtensionFactory = (pi) => Effect.runPromise(Effect.provide(registered(pi), router()));

export default extension;

export { addedHeaders, provider, registered };
