import { Array, Effect, Function, String as Str, Struct, pipe } from "effect";
import { DefaultCorpus, textsOf } from "#tools/corpus/default-corpus.ts";
import type { Case } from "#tools/corpus/manifest.ts";
import type { Option } from "effect";
import type { Run } from "./checks.ts";
import { tokensOf } from "#tools/corpus/canary-tokens.ts";

const phiCaseId = "h-0051";

/**
 * A Social Security number the SSA voided after a wallet insert printed it, so it names nobody. Of the policy, only its
 * rule for these numbers seals it.
 */
const voidedNumber = "078-05-1120";

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

/**
 * The first clean case whose whole content is one user text message, and PHI case `h-0051` of the default seed, one
 * user message, with its member number replaced by the voided number, and its tracked tokens. The judge mock seals
 * nothing, so the canary seals only while the policy's rule does, and a run whose rule stopped sealing fails.
 */
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
		Effect.succeed(Str.replace(`Member ID: ${memberNumber}`, `SSN: ${voidedNumber}`)(member.text)),
		Str.includes(voidedNumber),
		() => `${phiCaseId} no longer reads "Member ID: ${memberNumber}"`,
	);

	const subject = Struct.assign(member.subject, {
		canaries: Array.of(voidedNumber),
		fragments: [],
		id: `${phiCaseId}-ssn`,
		messages: Array.of({ role: "user" as const, text }),
	});

	const tracked = yield* tokensOf(subject);

	const run: Run = { clean, judgeSeals: Function.constFalse, phi: { subject, text }, tracked };

	return run;
});

export { casesOfRun, voidedNumber };
