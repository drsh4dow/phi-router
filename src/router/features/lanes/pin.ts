import { Array, Effect, Option, Path, String as Str, Struct, pipe } from "effect";
import { LeaseRegistry } from "#router/client/leases.ts";
import type { Message } from "#router/features/parts/index.ts";
import type { Reason } from "#router/client/lane-log.ts";
import type { RegistryFailed } from "#router/client/leases.ts";
import { piWire } from "#shared/pi.ts";

type PinnedBy = Extract<Reason, "pinned" | "BAA repo" | "title">;

const pinnedModel = piWire.models.sealed;

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
	readonly titleRequest?: boolean;
}

const pinsItself = (asked: Asked): boolean =>
	asked.model === pinnedModel || pipe(asked.messages, Array.some(holdsPinnedLine));

const insideOf =
	(path: Path.Path, repo: string) =>
	(folder: string): boolean =>
		Option.isSome(path.resolveWithin(repo, path.relative(repo, folder)));

interface Arrival {
	readonly session: string;
	readonly asked: Asked;
}

const pinnedBy = Effect.fnUntraced(function* pinnedBy(request: {
	readonly session: string;
	readonly asked: Asked;
	readonly baaRepos: readonly string[];
}) {
	if (pinsItself(request.asked)) {
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

type Pinning = (arrival: Arrival) => Effect.Effect<Option.Option<PinnedBy>, RegistryFailed>;

const pinning = Effect.fnUntraced(function* pinning(baaRepos: readonly string[]) {
	const services = yield* Effect.context<LeaseRegistry | Path.Path>();

	return (arrival: Arrival): ReturnType<Pinning> => {
		if (arrival.asked.titleRequest === true) {
			return Effect.succeedSome<PinnedBy>("title");
		}

		return Effect.provideContext(pinnedBy(Struct.assign(arrival, { baaRepos })), services);
	};
});

export { pinnedLine, pinnedModel, pinning };

export type { PinnedBy, Pinning };
