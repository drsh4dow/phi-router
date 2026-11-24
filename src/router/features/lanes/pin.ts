import { Array, Effect, Option, Path, String as Str, Struct, pipe } from "effect";
import { LeaseRegistry } from "#router/client/leases.ts";
import type { Message } from "#router/features/parts/index.ts";
import type { Reason } from "#router/client/lane-log.ts";
import type { RegistryFailed } from "#router/client/leases.ts";
import { piWire } from "#shared/pi.ts";

/**
 * Why a request runs wholly on the sealed lane with nothing judged: a pin, a BAA repo, or Codex's thread-title request,
 * which nothing ties to its session.
 */
type PinnedBy = Extract<Reason, "pinned" | "BAA repo" | "title">;

const pinnedModel = piWire.models.sealed;

/** The first line of the pinned subagent's instructions, which reach its system prompt whatever model it runs on. */
const pinnedLine = "phi-router: pinned subagent.";

const holdsPinnedLine = (message: Message): boolean =>
	message.role === "system" &&
	pipe(
		[
			message.content,
			...pipe(
				message.sections,
				Array.map(({ text }) => text),
			),
		],
		Array.some(Str.includes(pinnedLine)),
	);

interface Asked {
	readonly model: string;
	readonly messages: readonly Message[];
	readonly title?: boolean;
}

/**
 * Whether a request pins itself: it names `phi/sealed`, or its system prompt holds `pinnedLine`, as a Claude Code
 * subagent's does when its main agent gave the `Agent` tool another model.
 *
 * @param {Asked} asked The request.
 * @returns {boolean} Whether it runs pinned.
 */
const pinsItself = (asked: Asked): boolean =>
	asked.model === pinnedModel || pipe(asked.messages, Array.some(holdsPinnedLine));

/**
 * Whether `folder` is `repo` or below it, compared by spelling, so a trailing `/` or a `.` does not matter and
 * `/repo-other` is not inside `/repo`.
 *
 * @param {Path.Path} path The path service.
 * @param {string} repo A BAA repo.
 * @returns {Function} Whether a folder is inside it.
 */
const insideOf =
	(path: Path.Path, repo: string) =>
	(folder: string): boolean =>
		Option.isSome(path.resolveWithin(repo, path.relative(repo, folder)));

interface Arrival {
	readonly session: string;
	readonly sessionPinned: boolean;
	readonly asked: Asked;
}

/**
 * Route.tla `Arrive`, the pin read once: the session's pin from the store read of its arrival or the request's own, then
 * whether a lease of the session names a working folder inside a BAA repo. The lease registry is read only when the
 * request is not pinned and `baaRepos` lists a repo.
 */
const pinnedBy = Effect.fnUntraced(function* pinnedBy(request: {
	readonly session: string;
	readonly sessionPinned: boolean;
	readonly asked: Asked;
	readonly baaRepos: readonly string[];
}) {
	if (request.sessionPinned || pinsItself(request.asked)) {
		return Option.some<PinnedBy>("pinned");
	}

	if (!Array.isReadonlyArrayNonEmpty(request.baaRepos)) {
		return Option.none<PinnedBy>();
	}

	const path = yield* Path.Path;
	const { adopted } = yield* LeaseRegistry;
	const leases = yield* adopted;

	const insideRepo = (folder: string): boolean =>
		pipe(
			request.baaRepos,
			Array.some((repo) => insideOf(path, repo)(folder)),
		);

	const held = pipe(
		leases,
		Array.some((lease) => lease.session === request.session && insideRepo(lease.folder)),
	);

	return pipe(
		Option.some<PinnedBy>("BAA repo"),
		Option.filter(() => held),
	);
});

/**
 * `pinnedBy` with `baaRepos` and the services in context, as the route calls it. Codex's title request is pinned for
 * `title` before anything is read.
 */
type Pinning = (arrival: Arrival) => Effect.Effect<Option.Option<PinnedBy>, RegistryFailed>;

const pinning = Effect.fnUntraced(function* pinning(baaRepos: readonly string[]) {
	const services = yield* Effect.context<LeaseRegistry | Path.Path>();

	return (arrival: Arrival): ReturnType<Pinning> => {
		if (arrival.asked.title === true) {
			return Effect.succeedSome<PinnedBy>("title");
		}

		return Effect.provideContext(pinnedBy(Struct.assign(arrival, { baaRepos })), services);
	};
});

export { pinnedLine, pinnedModel, pinning };

export type { PinnedBy, Pinning };
