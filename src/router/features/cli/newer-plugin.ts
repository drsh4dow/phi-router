import { Effect, Option, Schema, pipe } from "effect";
import { Release, isOlder } from "#router/primitives/release.ts";
import { ownVersion } from "./platform.ts";

interface VersionWait {
	readonly installed: string;
	readonly running: string;
}

const versionWait = Effect.fnUntraced(function* versionWait(router: string | undefined) {
	const read = yield* Effect.option(ownVersion);
	const running = Option.fromUndefinedOr(router);

	return pipe(
		read,
		Option.filter(Schema.is(Release)),
		Option.filter((installed) =>
			Option.match(running, { onNone: () => true, onSome: (version) => isOlder(version, installed) }),
		),
		Option.map((installed): VersionWait => ({
			installed,
			running: Option.getOrElse(running, () => "an older version"),
		})),
	);
});

const waitNotice = ({ installed, running }: VersionWait): string =>
	`phi-router ${installed} is installed. Your open windows still run ${running} until you close them all.`;

export { versionWait, waitNotice };

export type { VersionWait };
