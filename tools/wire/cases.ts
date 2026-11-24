import { Array, Effect, Function, String as Str, Struct, pipe } from "effect";
import { DefaultCorpus, textsOf } from "#tools/corpus/default-corpus.ts";
import type { Case } from "#tools/corpus/manifest.ts";
import type { Option } from "effect";
import type { Run } from "./checks.ts";
import { tokensOf } from "#tools/corpus/canary-tokens.ts";

const phiCaseId = "h-0051";

const voidedSsn = "078-05-1120";

const onlyTextOf = (subject: Case): readonly string[] => {
	const [first, ...rest] = subject.messages;

	if (Array.isReadonlyArrayNonEmpty(rest) || first.role !== "user") {
		return [];
	}

	return textsOf([first]);
};

const withText = <Subject extends Case>(
	cases: readonly Subject[],
): Option.Option<{ readonly subject: Subject; readonly text: string }> =>
	pipe(
		cases,
		Array.flatMap((subject) =>
			pipe(
				onlyTextOf(subject),
				Array.map((text) => ({ subject, text })),
			),
		),
		Array.head,
	);

const casesOfRun = Effect.gen(function* casesOfRun() {
	const { cleanCases, phiCases } = yield* DefaultCorpus;
	const clean = yield* Effect.fromOption(withText(cleanCases));

	const named = pipe(
		phiCases,
		Array.filter((subject) => subject.id === phiCaseId),
	);

	const member = yield* Effect.fromOption(withText(named));
	const [memberNumber] = member.subject.canaries;

	const text = yield* Effect.filterOrFail(
		Effect.succeed(Str.replace(`Member ID: ${memberNumber}`, `SSN: ${voidedSsn}`)(member.text)),
		Str.includes(voidedSsn),
		() => `${phiCaseId} no longer reads "Member ID: ${memberNumber}"`,
	);

	const subject = Struct.assign(member.subject, {
		canaries: Array.of(voidedSsn),
		fragments: [],
		id: `${phiCaseId}-ssn`,
		messages: Array.of({ role: "user" as const, text }),
	});

	const tracked = yield* tokensOf(subject);

	const run: Run = { clean, judgeSeals: Function.constFalse, phi: { subject, text }, tracked };

	return run;
});

export { casesOfRun, voidedSsn };
