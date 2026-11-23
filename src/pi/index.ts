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
	TurnEndEvent,
	TurnEndEventResult,
} from "@earendil-works/pi-coding-agent";
import { answered, anthropicCatalog, observerOn, routedProvider, usage } from "#pi/features/phi/phi.ts";
import { blockUploads, recordUse } from "#pi/features/uploads/index.ts";
import { compactionSent, promptSent } from "#pi/features/phi/proof.ts";
import { loopback, phiCommand, productPort } from "#shared/cli.ts";
import { BunServices } from "@effect/platform-bun";
import { NodeServices } from "@effect/platform-node";
import type { Observe } from "#pi/features/phi/phi.ts";
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

const free = { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 };

/** A model's id inside the provider `phi`, and the context and output limits pi holds it to. */
interface Limits {
	readonly id: string;
	readonly contextWindow: number;
	readonly maxTokens: number;
}

/**
 * The limits of one of phi's own models: `auto` routes each request, `sealed` pins it. pi has no subagent tool, so the
 * adapter ships none, and `/model phi/sealed` pins every request of the session while it is selected.
 *
 * @param {string} id The model's id inside the provider `phi`.
 * @returns {Limits} Its limits.
 */
const phiOwn = (id: string): Limits => ({ contextWindow: 200_000, id, maxTokens: 32_000 });

/**
 * A model of the provider `phi`.
 *
 * @param {Limits} limits Its id and limits.
 * @returns {object} The model.
 */
const phiModel = ({ contextWindow, id, maxTokens }: Limits): NonNullable<ProviderConfig["models"]>[number] => ({
	compat: { forceAdaptiveThinking: true },
	contextWindow,
	cost: free,
	id,
	input: ["text", "image"],
	maxTokens,
	name: `PHI ${id}`,
	reasoning: true,
});

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
 * @param {number} port The router's port.
 * @returns {ProviderConfig} The provider.
 */
const provider = (port: number): ProviderConfig => ({
	api: "anthropic-messages",
	apiKey: placeholderKey,
	baseUrl: `http://${loopback}:${String(port)}${piWire.base}`,
	headers: { [piWire.sessionHeader]: "" },
	models: pipe(Record.keys(piWire.models), Array.map(phiOwn), Array.appendAll(anthropicCatalog), Array.map(phiModel)),
});

/** What the header hook reads of pi's context: the session, and pi's logins. */
interface HeaderContext {
	readonly modelRegistry: Pick<ModelRegistry, "getApiKeyForProvider">;
	readonly sessionManager: Pick<SessionManager, "getSessionId">;
}

/** Headers by name, as pi sends them. */
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
 *   the session's status.
 */
const leased =
	(port: number, atStart: Observe): ExtensionHandler<SessionStartEvent> =>
	(_event, ctx) => {
		const lease = Router.use((client) => client.start(ctx.sessionManager.getSessionId(), ctx.cwd, port));
		const leasedThenShown = Effect.andThen(lease, atStart(ctx));

		return Effect.runPromise(Effect.provide(leasedThenShown, router()));
	};

/**
 * The turn hook: shows the session's routing once a turn ends.
 *
 * @param {Observe} afterTurn Shows it.
 * @returns {ExtensionHandler<TurnEndEvent>} The hook.
 */
const turnEnded =
	(afterTurn: Observe): ExtensionHandler<TurnEndEvent, TurnEndEventResult> =>
	(_event, ctx) =>
		Effect.runPromise(Effect.provide(afterTurn(ctx), router()));

/**
 * The handler of `/phi` for a router on `port`.
 *
 * @param {number} port The router's port.
 * @returns {Function} The handler, which pi runs in place of a prompt.
 */
const phiAnswered: (port: number) => RegisteredCommand["handler"] = (port) => (words, ctx) =>
	Effect.runPromise(Effect.provide(answered(port)(words, ctx), router()));

/**
 * The input hook for a router on `port`.
 *
 * @param {number} port The router's port.
 * @returns {ExtensionHandler<InputEvent, InputEventResult>} The hook.
 */
const checked =
	(port: number): ExtensionHandler<InputEvent, InputEventResult> =>
	(_event, ctx) =>
		Effect.runPromise(Effect.provide(promptSent(port)(ctx), router()));

/**
 * The compaction hook for a router on `port`.
 *
 * @param {number} port The router's port.
 * @returns {ExtensionHandler<SessionBeforeCompactEvent, SessionBeforeCompactResult>} The hook.
 */
const compacted =
	(port: number): ExtensionHandler<SessionBeforeCompactEvent, SessionBeforeCompactResult> =>
	(_event, ctx) =>
		Effect.runPromise(Effect.provide(compactionSent(port)(ctx), router()));

/**
 * Hooks pi to the router on `port`: the session's lease once it starts, and the router's proof before each prompt and
 * each compaction on `phi`.
 *
 * @param {ExtensionAPI} pi What pi gives an extension.
 * @param {number} port The router's port.
 * @param {Observe} atStart Shows the session's status once it holds its lease.
 */
const onRouter = (pi: Readonly<Pick<ExtensionAPI, "on">>, port: number, atStart: Observe): void => {
	pi.on("session_start", leased(port, atStart));
	pi.on("input", checked(port));
	pi.on("session_before_compact", compacted(port));
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
 * The pi package. It adds the provider `phi` at the router's address, the product port unless `PHI_ROUTER_PORT` names
 * another, keeps it off any proxy, starts the router for each session, checks the router before each of the provider's
 * prompts and compactions and fills in each of its requests. It adds `/phi`, shows the last request in the status bar
 * after each turn, and a notice for a turn that sealed, and keeps a session that used it from `/share` and `/bug`.
 *
 * @param {ExtensionAPI} pi What pi gives an extension.
 * @returns {Promise<void>} Done once the provider and the hooks are in place.
 */
const extension: ExtensionFactory = (pi) =>
	Effect.runPromise(
		Effect.gen(function* registered() {
			const port = yield* Config.Port(piWire.portVariable).pipe(Config.withDefault(productPort));

			const { afterTurn, atStart } = yield* observerOn(port);

			yield* bypassProxies;
			pi.registerProvider(routedProvider, provider(port));
			pi.on("session_start", blockUploads(routedProvider));
			onRouter(pi, port, atStart);
			pi.on("before_provider_headers", recordUse({ pi, provider: routedProvider }));
			pi.on("before_provider_headers", headed);
			pi.on("turn_end", turnEnded(afterTurn));
			pi.registerCommand(phiCommand.name, { description: usage, handler: phiAnswered(port) });
		}),
	);

export default extension;

export { addedHeaders, provider };
