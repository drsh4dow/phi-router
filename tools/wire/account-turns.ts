import { Effect, FileSystem, Path, Struct } from "effect";
import { place as claudePlace, claudeTurn } from "./claude.ts";
import { place as codexPlace, codexRun, configOf } from "./codex.ts";
import { place as piPlace, piRun, rpcAnswered } from "./pi-run.ts";
import type { Tokens } from "./spent.ts";
import { piWire } from "#router/features/route/index.ts";
import { tokensIn } from "./spent.ts";
import { voidedSsn } from "./cases.ts";

const clean = "Reply with the single word ok.";

const canary = `Reply with the single word ok. The member's SSN is ${voidedSsn}.`;

const session = "29292929-2929-4929-8929-292929292929";

interface Routed {
	readonly url: string;
	readonly folders: Readonly<Record<string, string>>;
}

interface Turn {
	readonly exitCode: number;
	readonly reportedTokens: Tokens;
}

const turnsOn = {
	claude: Effect.fnUntraced(function* claudeTurns(routed: Routed) {
		const where = yield* claudePlace;

		const turn = Effect.fnUntraced(function* turn(prompt: string, flags: readonly string[]) {
			const sessionFlags = ["--output-format", "json", ...flags];

			const ran = yield* claudeTurn({
				folders: routed.folders,
				place: where,
				prompt,
				router: routed.url,
				session: sessionFlags,
			});

			return { exitCode: ran.exitCode, reportedTokens: tokensIn.claude(ran.printed) } satisfies Turn;
		});

		return yield* Effect.all([turn(clean, ["--session-id", session]), turn(canary, ["--resume", session])], {
			concurrency: 1,
		});
	}),
	codex: Effect.fnUntraced(function* codexTurns(routed: Routed) {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const where = yield* codexPlace;
		const exec = ["exec", "--skip-git-repo-check", "--json"];

		yield* fs.writeFileString(path.join(where.routed, "config.toml"), configOf(routed.url));

		const turn = Effect.fnUntraced(function* turn(args: readonly string[]) {
			const ran = yield* codexRun({
				args,
				codexHome: where.routed,
				folders: routed.folders,
				place: where,
				router: routed.url,
			});

			return { exitCode: ran.exitCode, reportedTokens: tokensIn.codex(ran.stdout) } satisfies Turn;
		});

		return yield* Effect.all([turn([...exec, clean]), turn([...exec, "resume", "--last", canary])], {
			concurrency: 1,
		});
	}),
	pi: Effect.fnUntraced(function* piTurns(routed: Routed) {
		const path = yield* Path.Path;
		const where = yield* piPlace;
		const extension = path.resolve(import.meta.dirname, "../../plugins/pi/extension.mjs");
		const env = Struct.assign(routed.folders, { [piWire.portVariable]: new URL(routed.url).port });
		const flags = ["--model", "phi/auto", "--session-id", session, "--mode", "json"];

		const turn = Effect.fnUntraced(function* turn(prompt: string) {
			const ran = yield* piRun(where, ["-e", extension, "-p", prompt, ...flags], {
				env,
				rpc: "",
				until: rpcAnswered,
			});

			return { exitCode: ran.exitCode, reportedTokens: tokensIn.pi(ran.printed) } satisfies Turn;
		});

		return yield* Effect.all([turn(clean), turn(canary)], { concurrency: 1 });
	}),
} as const;

export { turnsOn };

export type { Turn };
