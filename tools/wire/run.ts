import { Array, Console, Effect, FileSystem, Path, Schema, String as Str, pipe } from "effect";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import type { Check } from "./checks.ts";
import { DefaultCorpus } from "#tools/corpus/default-corpus.ts";
import { Digest } from "effect/crypto";
import type { LaneLogLine } from "#tools/route/mocked-router.ts";
import { casesOfRun } from "./cases.ts";
import { plays } from "./plays.ts";

const runtimeAndScript = 2;

const firstTurnNumber = 1;

const Harness = Schema.Literals(["claude", "codex", "pi"]);

type Played = typeof Harness.Type;

interface Report {
	readonly harness: Played;
	readonly cases: { readonly clean: string; readonly phi: string };
	readonly checks: readonly Check[];
	readonly lanes: readonly LaneLogLine[];
	readonly turns: readonly {
		readonly turn: number;
		readonly exitCode: number;
		readonly printed: string;
		readonly open: number;
		readonly baa: number;
	}[];
}

const playing = Effect.fnUntraced(function* playing(harness: Played) {
	const run = yield* casesOfRun;
	const { checks, stored, turns } = yield* plays[harness](run);

	return {
		cases: { clean: run.clean.subject.id, phi: run.phi.subject.id },
		checks,
		harness,
		lanes: stored.lines,
		turns: pipe(
			turns,
			Array.map(({ baa, exitCode, open, printedTail }, index) => ({
				baa: baa.length,
				exitCode,
				open: open.length,
				printed: printedTail,
				turn: index + firstTurnNumber,
			})),
		),
	} satisfies Report;
});

const verdictOf = (check: Check): string => {
	if (check.ok) {
		return `pass ${check.name}`;
	}

	return `FAIL ${check.name}`;
};

const summaryOf = (report: Report, reportPath: string): string => {
	const perTurn = pipe(
		report.turns,
		Array.map(
			({ baa, exitCode, open, turn }) =>
				`turn ${String(turn)}: ${report.harness} exited ${String(exitCode)}, ${String(open)} open and ${String(baa)} BAA requests`,
		),
	);

	return Array.join(
		[
			`wire ${report.harness}: cases ${report.cases.clean} (clean) and ${report.cases.phi} (PHI), report in ${reportPath}`,
			...perTurn,
			...pipe(report.checks, Array.map(verdictOf)),
		],
		"\n",
	);
};

const reportJson = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const reportPathOf = Effect.fnUntraced(function* reportPathOf(given: string) {
	if (Str.isNonEmpty(given)) {
		return given;
	}

	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const folder = yield* fs.makeTempDirectory({ prefix: "phi-wire-report-" });

	return path.join(folder, "wire-report.json");
});

const program = Effect.gen(function* program() {
	const [harness = "", given = ""] = Array.drop(process.argv, runtimeAndScript);
	const fs = yield* FileSystem.FileSystem;

	const played = yield* Effect.filterOrFail(
		Effect.succeed(harness),
		Schema.is(Harness),
		(named) => `bun run wire takes one harness, claude, codex or pi. It got "${named}".`,
	);

	const reportPath = yield* reportPathOf(given);
	const report = yield* playing(played);
	const json = yield* reportJson(report);

	yield* fs.writeFileString(reportPath, `${json}\n`);
	yield* Console.log(summaryOf(report, reportPath));

	return yield* Effect.filterOrFail(
		Effect.succeed(report.checks),
		Array.every((check) => check.ok),
		() => "a wire check failed",
	);
});

NodeRuntime.runMain(
	program.pipe(Effect.scoped, Effect.provide([DefaultCorpus.layer, NodeServices.layer, Digest.layerWebCrypto])),
);
