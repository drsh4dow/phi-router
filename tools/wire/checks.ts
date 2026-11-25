import { Array, Function, Option, String as Str, pipe } from "effect";
import { laneLogHolds, windowsOf } from "./stored.ts";
import type { Case } from "#tools/corpus/manifest.ts";
import type { Sent } from "#router/client/mock-upstreams/index.ts";
import type { Stored } from "./stored.ts";
import type { Tracked } from "#tools/corpus/canary-tokens.ts";
import { fakes } from "#tools/route/mocked-router.ts";
import { foundIn } from "#tools/corpus/request-bodies.ts";
import { stubsFor } from "#router/features/border/index.ts";

const succeeded = 0;

const dataFirstArity = 2;

interface Turned {
	readonly exitCode: number;
	readonly printedTail: string;
	readonly open: readonly Sent[];
	readonly baa: readonly Sent[];
}

interface Played {
	readonly turns: readonly Turned[];
	readonly stored: Stored;
	readonly sessions: readonly string[];
	readonly cleanText: string;
	readonly phiCase: string;
	readonly canaries: readonly string[];
	readonly corpusTokens: readonly string[];
}

interface ClaudePlayed extends Played {
	readonly turns: readonly [clean: Turned, canary: Turned, followUp: Turned, tool: Turned, ...phi: Turned[]];
}

interface CodexTurned extends Turned {
	readonly stdout: string;
	readonly stderr: string;
	readonly fellBackToDefaultMetadata: boolean;
}

interface Listing {
	readonly listedByCodex: readonly string[];
	readonly servedByOpenMock: readonly string[];
	readonly remote: string;
}

interface CodexPlayed extends Played, Listing {
	readonly turns: readonly [
		models: CodexTurned,
		clean: CodexTurned,
		canary: CodexTurned,
		followUp: CodexTurned,
		tool: CodexTurned,
		...phi: CodexTurned[],
	];
}

interface Check {
	readonly name: string;
	readonly ok: boolean;
}

interface Subject {
	readonly subject: Case;
	readonly text: string;
}

interface Run {
	readonly clean: Subject;
	readonly phi: Subject;
	readonly tracked: Tracked;
	readonly judgeSeals: (piece: string) => boolean;
}

interface Outcome {
	readonly checks: readonly Check[];
	readonly stored: Played["stored"];
	readonly turns: readonly Turned[];
}

const none = (tokens: readonly string[], bodies: readonly string[]): boolean =>
	!Array.isReadonlyArrayNonEmpty(foundIn(bodies)(tokens));

const holds = (tokens: readonly string[], sent: Sent): boolean => !none(tokens, [sent.body]);

const isAsSent = ({ headers, body }: Sent): boolean =>
	headers["authorization"] === `Bearer ${fakes.harnessToken}` && Str.includes(`"model":"${fakes.targetModel}"`)(body);

const isBaaOnly = ({ headers }: Sent): boolean =>
	headers["x-api-key"] === fakes.baaKey && Option.isNone(Option.fromNullishOr(headers["authorization"]));

const isForwardedLogin = ({ headers }: Sent): boolean =>
	headers["authorization"] === `Bearer ${fakes.harnessToken}` && headers["chatgpt-account-id"] === fakes.accountId;

const isBaaKeyOnly = ({ headers }: Sent): boolean =>
	headers["authorization"] === `Bearer ${fakes.baaKey}` &&
	Option.isNone(Option.fromNullishOr(headers["chatgpt-account-id"]));

const isPost = ({ method }: Sent): boolean => method === "POST";

const isTarget = ({ body }: Sent): boolean => Str.includes(`"model":"${fakes.targetModel}"`)(body);

const holdsToolOutput = ({ body }: Sent): boolean => Str.includes('"function_call_output"')(body);

const sentIn = (turns: readonly Turned[], mock: "open" | "baa"): readonly Sent[] =>
	pipe(
		turns,
		Array.flatMap((turn) => turn[mock]),
	);

const someHold = (tokens: readonly string[], sent: readonly Sent[]): boolean =>
	pipe(
		sent,
		Array.some((one) => holds(tokens, one)),
	);

const everyOf: {
	<Item>(predicate: (item: Item) => boolean): (items: readonly Item[]) => boolean;
	<Item>(items: readonly Item[], predicate: (item: Item) => boolean): boolean;
} = Function.dual(
	dataFirstArity,
	<Item>(items: readonly Item[], predicate: (item: Item) => boolean): boolean =>
		Array.isReadonlyArrayNonEmpty(items) && pipe(items, Array.every(predicate)),
);

const leftOf = <Turns extends readonly Turned[]>(left: {
	readonly run: Run;
	readonly prompts: readonly string[];
	readonly sessions: readonly string[];
	readonly stored: Played["stored"];
	readonly turns: Turns;
}): Played & { readonly turns: Turns } => ({
	canaries: left.run.tracked.wholeCanaryTokens,
	cleanText: left.run.clean.text,
	corpusTokens: [
		...left.run.phi.subject.canaries,
		...left.run.tracked.wholeCanaryTokens,
		...left.run.tracked.sealedWindows,
		...pipe(left.prompts, Array.flatMap(windowsOf)),
	],
	phiCase: left.run.phi.subject.id,
	sessions: left.sessions,
	stored: left.stored,
	turns: left.turns,
});

const commonChecksOf =
	(harness: string) =>
	(played: Played): readonly Check[] => [
		{ name: `every ${harness} run exits 0`, ok: everyOf(played.turns, (turn) => turn.exitCode === succeeded) },
		{
			name: `no open body holds a complete canary of ${played.phiCase}`,
			ok: !someHold(played.canaries, sentIn(played.turns, "open")),
		},
		{
			name: "no file under the state folder holds corpus text",
			ok: none(played.corpusTokens, played.stored.fileTexts),
		},
		{
			name: "every folder under the XDG state and config folders is 0700 and every file 0600",
			ok: Array.isReadonlyArrayEmpty(played.stored.notPrivate),
		},
		{
			name: "every lane log line names a session the harness kept",
			ok: everyOf(played.stored.lines, (line) => Array.contains(played.sessions, line.session)),
		},
		{
			name: "the lane log has one line per model request an account took, and no content key",
			ok: laneLogHolds(played),
		},
	];

const checksOf = (played: ClaudePlayed): readonly Check[] => {
	const [clean, canary, followUp, tool] = played.turns;
	const cleanWindows = windowsOf(played.cleanText);

	const cleanCase = pipe(
		clean.open,
		Array.filter((sent) => holds(cleanWindows, sent)),
	);

	return [
		{
			name: "the clean case reaches the open mock with the binary's Authorization and the target model",
			ok: everyOf(cleanCase, isAsSent),
		},
		{
			name: "the canary case reaches the BAA mock with the BAA key and without the open credential",
			ok: someHold(played.canaries, canary.baa) && pipe(sentIn(played.turns, "baa"), Array.every(isBaaOnly)),
		},
		{
			name: "the follow-up reaches the open mock with the stub in place of the sealed part",
			ok: someHold([stubsFor.claude], followUp.open),
		},
		{
			name: "the open mock answers a Read, and Claude Code posts its tool result",
			ok: pipe(
				tool.open,
				Array.some(({ body }) => Str.includes('"tool_result"')(body)),
			),
		},
		...commonChecksOf("claude")(played),
	];
};

const codexChecksOf = (played: CodexPlayed): readonly Check[] => {
	const [models, clean, canary, followUp, tool] = played.turns;
	const isListed = (slug: string): boolean => pipe(played.listedByCodex, Array.contains(slug));

	return [
		{
			name: "codex debug models lists phi/auto beside every model the open mock served",
			ok: everyOf(["phi/auto", ...played.servedByOpenMock], isListed),
		},
		{
			name: "the open mock's catalog request carries the forwarded login",
			ok: everyOf(models.open, isForwardedLogin),
		},
		{
			name: "no codex run fell back to default model metadata",
			ok: !pipe(
				played.turns,
				Array.some((turn) => turn.fellBackToDefaultMetadata),
			),
		},
		{
			name: "the clean case reaches the open mock with the forwarded login and the target model",
			ok: everyOf(pipe(clean.open, Array.filter(isPost)), (sent) => isForwardedLogin(sent) && isTarget(sent)),
		},
		{
			name: "the canary case reaches the BAA mock with the BAA key alone",
			ok: someHold(played.canaries, canary.baa) && pipe(sentIn(played.turns, "baa"), Array.every(isBaaKeyOnly)),
		},
		{
			name: "codex runs the BAA mock's tool call and the canary turn finishes on the open mock",
			ok: pipe(canary.open, Array.some(holdsToolOutput)),
		},
		{
			name: "the follow-up reaches the open mock with the stub in place of the sealed part",
			ok: someHold([stubsFor.codex], followUp.open),
		},
		{
			name: "a canary in a tool result reaches the BAA mock",
			ok: pipe(
				tool.baa,
				Array.some((sent) => holdsToolOutput(sent) && holds(played.canaries, sent)),
			),
		},
		{
			name: "no open body names the working folder's git remote",
			ok: !someHold([played.remote], sentIn(played.turns, "open")),
		},
		...commonChecksOf("codex")(played),
	];
};

const verdictOf = ({ name, ok }: Check): string => {
	if (ok) {
		return `pass ${name}`;
	}

	return `FAIL ${name}`;
};

export { checksOf, codexChecksOf, commonChecksOf, everyOf, isAsSent, isBaaOnly, leftOf, succeeded, verdictOf };

export type { Check, CodexTurned, Listing, Outcome, Played, Run, Turned };
