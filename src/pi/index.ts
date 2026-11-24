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

/** The router's launcher in the package, `plugins/claude/bin/`, beside this extension's bundle in `plugins/pi/`. */
const launcher = decodeURIComponent(new URL("../claude/bin/phi-router", import.meta.url).pathname);

/** The provider whose login pi sends, which the router forwards to the account the configuration names for it. */
const loginProvider = "anthropic";

/**
 * Not a credential. Its `sk-ant-oat` prefix makes pi send Claude Code's headers and system block, which a subscription
 * login needs, and each request carries pi's own login in its place.
 */
const placeholderKey = "sk-ant-oat-phi-router";

/**
 * The router client on the platform of the runtime pi runs on, which the entry file picks.
 *
 * @returns {Layer.Layer<Router>} The client.
 */
const router = (): Layer.Layer<Router> => {
	if ("Bun" in globalThis) {
		return Layer.provide(Router.layer(launcher), BunServices.layer);
	}

	return Layer.provide(Router.layer(launcher), NodeServices.layer);
};

/**
 * The provider `phi` at the router on `port`. The empty session header marks a request of this provider for the header
 * hook, which fills it.
 *
 * @param {object} served The router's port, and the models `config.json` names for each vendor.
 * @returns {ProviderConfig} The provider.
 */
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

/**
 * The headers a request of the provider `phi`, which the empty session header marks, adds: its session and pi's own
 * login. A request of another provider adds none and goes out as pi sends it.
 *
 * @param {HeaderContext} ctx The session and pi's logins.
 * @returns {(sent: Headers) => Effect.Effect<Headers>} The headers to add to `sent`.
 */
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

/**
 * Sets the headers `addedHeaders` names on the request pi is about to send.
 *
 * @param {BeforeProviderHeadersEvent} event The headers, which pi reads back after the hook.
 * @param {ExtensionContext} ctx The session and pi's logins.
 * @returns {Promise<void>} Done once the headers are set.
 */
const headed: ExtensionHandler<BeforeProviderHeadersEvent> = (event, ctx) =>
	Effect.runPromise(
		Effect.map(addedHeaders(ctx)(event.headers), (added) => {
			for (const [name, value] of Record.toEntries(added)) {
				event.headers[name] = value;
			}
		}),
	);

/**
 * The session hook for a router on `port`.
 *
 * @param {number} port The router's port.
 * @param {Observe} atStart Shows the session's status.
 * @returns {ExtensionHandler<SessionStartEvent>} A hook that leaves a lease for pi's process and the session with the
 *   router, starting the router when none runs, and that pi awaits before the session's first request. It then shows
 *   the session's status. When it cannot leave the lease it says nothing, since no message is stopped yet, and the
 *   input hook tells why once a prompt would go.
 */
const leased =
	(port: number, atStart: Observe): ExtensionHandler<SessionStartEvent> =>
	(_event, ctx) => {
		const lease = Router.use((client) => client.start(ctx.sessionManager.getSessionId(), ctx.cwd, port));

		const leasedThenShown = Effect.andThen(lease, atStart(ctx)).pipe(
			Effect.catchTag("CommandFailed", () => Effect.void),
		);

		return Effect.runPromise(Effect.provide(leasedThenShown, router()));
	};

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

/**
 * Hooks pi to the router on `port`: the session's lease once it starts, the router's proof before each prompt and each
 * compaction on `phi`, and the session's status after each turn and each model switch.
 *
 * @param {ExtensionAPI} pi What pi gives an extension.
 * @param {number} port The router's port.
 * @param {object} shows `atStart` shows the session's status once it holds its lease and after a model switch,
 *   `afterTurn` after each turn.
 */
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

/**
 * Adds the router's address to `NO_PROXY` and `no_proxy` in pi's own process, which its proxy agent reads before each
 * request, so a proxy the user's shell or pi's settings name never sees a request of `phi`.
 */
const bypassProxies = Effect.forEach(
	["NO_PROXY", "no_proxy"],
	(name) =>
		Effect.map(Config.String(name).pipe(Config.withDefault("")), (named) => {
			globalThis.process.env[name] = pipe([named, loopback], Array.filter(Str.isNonEmpty), Array.join(","));
		}),
	{ concurrency: 1, discard: true },
);

/**
 * The router's port, the product port unless `PHI_ROUTER_PORT` names another, and the models `config.json` names for
 * each vendor, none when `phi-router models` fails, as on a file the router refuses.
 */
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

/**
 * The pi package. It adds the provider `phi` at the router's address, the product port unless `PHI_ROUTER_PORT` names
 * another, with `auto` and `sealed` at the limits of the models they run, keeps it off any proxy, starts the router for each session, checks the router before each of the provider's
 * prompts and compactions and fills in each of its requests. It adds `/phi`, shows the last request in the status bar
 * on a `phi` model after each turn and each model switch, and a notice for a turn that sealed, and keeps a session that used it from `/share` and `/bug`.
 *
 * @param {ExtensionAPI} pi What pi gives an extension.
 * @returns {Promise<void>} Done once the provider and the hooks are in place.
 */
const extension: ExtensionFactory = (pi) =>
	Effect.runPromise(
		Effect.provide(
			Effect.gen(function* registered() {
				const { models, port } = yield* configured;

				const shows = yield* observerOn(port);

				yield* bypassProxies;
				pi.registerProvider(routedProvider, provider({ models, port }));
				pi.on("session_start", blockUploads(routedProvider));
				onRouter(pi, port, shows);
				pi.on("before_provider_headers", recordUse({ pi, provider: routedProvider }));
				pi.on("before_provider_headers", headed);
				pi.registerCommand(phiCommand.name, { description: usage, handler: phiAnswered(port) });
			}),
			router(),
		),
	);

export default extension;

export { addedHeaders, provider };
