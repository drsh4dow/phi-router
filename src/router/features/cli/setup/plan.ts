import { Array, Option, Predicate, Struct, pipe } from "effect";
import type { ChoiceId, QuestionId } from "#shared/cli.ts";
import type { FoundKey, KeyPlace, Named } from "./copy.ts";
import type { KeySource, Vendor } from "#router/client/configuration/index.ts";
import { keyName, macNote, named, readyMark, roleNames, rows, shown, signInNamed, stops, vendorNames } from "./copy.ts";
import type { SignIn } from "#router/client/harnesses/index.ts";

type Choice = typeof ChoiceId.Type;

type Answers = Readonly<Partial<Record<typeof QuestionId.Type, Choice>>>;

interface Question {
	readonly id: typeof QuestionId.Type;
	readonly text: string;
	readonly choices: readonly { readonly id: Choice; readonly label: string }[];
}

interface KeptRole {
	readonly label: Named;
	readonly key?: KeySource | undefined;
	readonly rekey: boolean;
}

interface Kept {
	readonly open?: KeptRole | undefined;
	readonly baa?: KeptRole | undefined;
	readonly judge?: KeptRole | undefined;
}

interface Found {
	readonly vendor: Vendor;
	readonly title: string;
	readonly signInHow: string;
	readonly own: SignIn;
	readonly others: readonly { readonly title: string; readonly signIn: SignIn }[];
	readonly keys: readonly FoundKey[];
	readonly blocked?: string | undefined;
	readonly kept: Kept;
	readonly mac: boolean;
}

type Filler =
	| { readonly kind: "kept"; readonly label: Named }
	| { readonly kind: "forwarded"; readonly label: Named }
	| { readonly kind: "harnessFolder"; readonly label: Named }
	| { readonly kind: "signIn"; readonly role: "open" | "baa" }
	| { readonly kind: "key"; readonly vendor: Vendor; readonly place: KeyPlace | "typed" }
	| { readonly kind: "source"; readonly vendor: Vendor; readonly source: KeySource; readonly label: Named };

interface Roles {
	readonly open: Filler;
	readonly baa: Filler;
	readonly judge: Filler;
}

type Pending = { readonly kind: "ask"; readonly question: Question } | { readonly kind: "stop"; readonly line: string };

interface Ready {
	readonly kind: "ready";
	readonly roles: Roles;
	readonly typed: readonly Vendor[];
}

type Step = Pending | Ready;

interface Sides {
	readonly kind: "sides";
	readonly open: Filler;
	readonly baa?: Filler | undefined;
}

const stop = (line: string): Pending => ({ kind: "stop", line });

const ask = (question: Question): Pending => ({ kind: "ask", question });

const isPending = (decided: Filler | Pending | Sides): decided is Pending =>
	decided.kind === "ask" || decided.kind === "stop";

const kept = (role: KeptRole): Filler => ({ kind: "kept", label: role.label });

const typed = (vendor: Vendor): Filler => ({ kind: "key", place: "typed", vendor });

const stopOf = (found: Found): Option.Option<string> => {
	const { own } = found;

	if (own.kind === "provider") {
		return Option.some(stops.provider(own.provider));
	}

	if (Predicate.isNotUndefined(found.blocked)) {
		return Option.some(found.blocked);
	}

	if (own.kind === "none") {
		return Option.some(stops.signedOut(found.title, found.signInHow));
	}

	if (own.kind === "apiKey") {
		return Option.some(stops.apiKey);
	}

	return Option.none();
};

const enterpriseQuestion = (account: string | undefined): Question => ({
	choices: [
		{ id: "yes", label: "Yes" },
		{ id: "no", label: "No" },
	],
	id: "enterprise",
	text: pipe(
		Option.fromUndefinedOr(account),
		Option.match({
			onNone: () => "Does your BAA cover your Claude Enterprise login?",
			onSome: (name) => `Does your BAA cover Claude Enterprise (${name})?`,
		}),
	),
});

const everydayQuestion: Question = {
	choices: [
		{ id: "subscription", label: "Claude Pro or Max" },
		{ id: "nothing", label: "Nothing else" },
	],
	id: "everyday",
	text: "What do you use for everyday work?",
};

const foundChoices = (found: Found, vendor: Vendor): Question["choices"] =>
	pipe(
		found.keys,
		Array.filter((key) => key.vendor === vendor),
		Array.map((key) => ({ id: key.place, label: keyName(key) })),
	);

const openaiQuestion = (found: Found, id: Question["id"]): Question => ({
	choices: [
		{ id: "key", label: "Another OpenAI key" },
		...foundChoices(found, "openai"),
		{ id: "none", label: "I don't have one" },
	],
	id,
	text: "Which OpenAI key does your BAA cover?",
});

const signInChoices = (found: Found): Question["choices"] => {
	if (found.mac) {
		return [];
	}

	return [{ id: "signIn", label: "Claude Enterprise login" }];
};

const anthropicQuestion = (found: Found): Question => ({
	choices: [{ id: "key", label: "Anthropic API key" }, ...signInChoices(found), ...foundChoices(found, "anthropic")],
	id: "baa",
	text: "Which account does your BAA cover?",
});

const answered = (question: Question, answers: Answers): Option.Option<Choice> =>
	pipe(
		Option.fromUndefinedOr(answers[question.id]),
		Option.filter((answer) =>
			pipe(
				question.choices,
				Array.some(({ id }) => id === answer),
			),
		),
	);

const keyFiller = (vendor: Vendor, choice: Choice): Filler | Pending => {
	if (choice === "none") {
		return stop(stops.noJudge);
	}

	if (choice === "signIn") {
		return { kind: "signIn", role: "baa" };
	}

	if (choice === "env" || choice === "pi" || choice === "saved") {
		return { kind: "key", place: choice, vendor };
	}

	return typed(vendor);
};

const onlyChoice = 1;

const chosen = (question: Question, answers: Answers, vendor: Vendor): Filler | Pending => {
	const options = pipe(
		question.choices,
		Array.filter(({ id }) => id !== "none"),
	);

	const picked = answered(question, answers);

	if (options.length === onlyChoice && Option.isNone(picked)) {
		return typed(vendor);
	}

	return Option.match(picked, {
		onNone: () => ask(question),
		onSome: (choice) => keyFiller(vendor, choice),
	});
};

const enterpriseSides = (found: Found, answers: Answers, account: string | undefined): Sides | Pending => {
	const label = signInNamed(found.own);
	const covered = answered(enterpriseQuestion(account), answers);

	if (Option.isNone(covered)) {
		return ask(enterpriseQuestion(account));
	}

	if (covered.value === "no") {
		return { kind: "sides", open: { kind: "forwarded", label } };
	}

	if (found.mac) {
		return stop(stops.mac);
	}

	const everyday = answered(everydayQuestion, answers);

	if (Option.isNone(everyday)) {
		return ask(everydayQuestion);
	}

	if (everyday.value === "nothing") {
		return stop(stops.onlyBaa);
	}

	return { baa: { kind: "harnessFolder", label }, kind: "sides", open: { kind: "signIn", role: "open" } };
};

const sidesOf = (found: Found, answers: Answers): Sides | Pending => {
	const { kept: held, own } = found;

	const keptBaa = pipe(
		Option.fromUndefinedOr(held.baa),
		Option.filter((role) => !role.rekey),
		Option.map(kept),
		Option.getOrUndefined,
	);

	if (Predicate.isNotUndefined(held.open)) {
		return { baa: keptBaa, kind: "sides", open: kept(held.open) };
	}

	if (own.kind === "enterprise" && Predicate.isUndefined(held.baa)) {
		return enterpriseSides(found, answers, own.account);
	}

	return { baa: keptBaa, kind: "sides", open: { kind: "forwarded", label: signInNamed(own) } };
};

const rekeyed = (role: KeptRole | undefined): boolean =>
	pipe(
		Option.fromUndefinedOr(role),
		Option.exists(({ rekey }) => rekey),
	);

const keptSource = (role: KeptRole | undefined): Filler | undefined =>
	pipe(
		Option.fromUndefinedOr(role),
		Option.filter(({ rekey }) => !rekey),
		Option.flatMap(({ key }) => Option.fromUndefinedOr(key)),
		Option.map((source): Filler => ({ kind: "source", label: named("OpenAI API key"), source, vendor: "openai" })),
		Option.getOrUndefined,
	);

const baaOf = (found: Found, answers: Answers, side: Sides): Filler | Pending => {
	if (Predicate.isNotUndefined(side.baa)) {
		return side.baa;
	}

	if (rekeyed(found.kept.baa)) {
		return typed(found.vendor);
	}

	if (found.vendor === "anthropic") {
		return chosen(anthropicQuestion(found), answers, "anthropic");
	}

	return keptSource(found.kept.judge) ?? chosen(openaiQuestion(found, "baa"), answers, "openai");
};

const judgeOf = (found: Found, answers: Answers, baa: Filler): Filler | Pending => {
	const sharesBaaKey = found.vendor === "openai" && baa.kind === "key";

	if (rekeyed(found.kept.judge) && !sharesBaaKey) {
		return typed("openai");
	}

	if (Predicate.isNotUndefined(found.kept.judge) && !rekeyed(found.kept.judge)) {
		return kept(found.kept.judge);
	}

	if (sharesBaaKey || (found.vendor === "openai" && baa.kind === "source")) {
		return baa;
	}

	const shared = Option.liftPredicate(found.kept.baa, () => found.vendor === "openai").pipe(Option.getOrUndefined);

	return keptSource(shared) ?? chosen(openaiQuestion(found, "judge"), answers, "openai");
};

const typedVendors = (roles: Roles): readonly Vendor[] =>
	pipe(
		[roles.open, roles.baa, roles.judge],
		Array.flatMap((filler) => {
			if (filler.kind === "key" && filler.place === "typed") {
				return [filler.vendor];
			}

			return [];
		}),
		Array.dedupe,
	);

const plan = ({ answers, found }: { readonly found: Found; readonly answers: Answers }): Step => {
	const stopped = stopOf(found);

	if (Option.isSome(stopped)) {
		return stop(stopped.value);
	}

	const side = sidesOf(found, answers);

	if (isPending(side)) {
		return side;
	}

	const baa = baaOf(found, answers, side);

	if (isPending(baa)) {
		return baa;
	}

	const judge = judgeOf(found, answers, baa);

	if (isPending(judge)) {
		return judge;
	}

	const roles = { baa, judge, open: side.open };

	return { kind: "ready", roles, typed: typedVendors(roles) };
};

const needed = (found: Found, vendor: Vendor, missing: string): string => {
	const has = pipe(
		found.keys,
		Array.some((key) => key.vendor === vendor),
	);

	if (has) {
		return "pick below";
	}

	return missing;
};

const keptOr = (role: KeptRole | undefined, otherwise: string): string =>
	pipe(
		Option.fromUndefinedOr(role),
		Option.match({
			onNone: () => otherwise,
			onSome: ({ label, rekey }) =>
				Option.getOrElse(
					Option.liftPredicate("needs a new key", () => rekey),
					() => readyMark(shown(label)),
				),
		}),
	);

const baaMissing = { anthropic: "needs a BAA account", openai: "needs an OpenAI key" } as const;

const roleLines = (found: Found): readonly (readonly [string, string])[] => {
	const { kept: held, own, vendor } = found;
	const ownName = readyMark(shown(signInNamed(own)));

	const judgeMissing = Option.getOrElse(
		Option.liftPredicate("same key", () => vendor === "openai"),
		() => needed(found, "openai", "needs an OpenAI key"),
	);

	const judge = [roleNames.judge, keptOr(held.judge, judgeMissing)] as const;

	if (own.kind === "enterprise" && Predicate.isUndefined(held.open) && Predicate.isUndefined(held.baa)) {
		return [judge];
	}

	return [
		[roleNames.open, keptOr(held.open, ownName)],
		[roleNames.baa, keptOr(held.baa, needed(found, vendor, baaMissing[vendor]))],
		judge,
	];
};

const macLines = (found: Found): readonly string[] => {
	if (found.mac && found.vendor === "anthropic" && Predicate.isUndefined(found.kept.baa)) {
		return [macNote];
	}

	return [];
};

const alsoFound = (found: Found): readonly (readonly [string, string])[] =>
	pipe(
		found.keys,
		Array.map(keyName),
		Array.match({
			onEmpty: () => [],
			onNonEmpty: ([first, ...rest]) => [
				["Also found", first] as const,
				...pipe(
					rest,
					Array.map((name) => ["", name] as const),
				),
			],
		}),
	);

const foundScreen = (found: Found): readonly string[] => {
	const harnesses = rows([
		[found.title, shown(signInNamed(found.own))],
		...pipe(
			found.others,
			Array.map(({ signIn, title }) => [title, shown(signInNamed(signIn))] as const),
		),
	]);

	if (Option.isSome(stopOf(found))) {
		return ["phi-router found", ...harnesses];
	}

	return [
		"phi-router found",
		...harnesses,
		...rows(alsoFound(found)),
		"",
		...rows(roleLines(found)),
		...macLines(found),
	];
};

const keyPrompt = ({ roles, vendor }: { readonly vendor: Vendor; readonly roles: Roles }): string => {
	if (roles.baa.kind === "key" && roles.baa.vendor === vendor) {
		return `${vendorNames[vendor]} key (BAA):`;
	}

	return `${vendorNames[vendor]} key (PHI check):`;
};

const keyNamed = (filler: Extract<Filler, { kind: "key" }>): Named => {
	if (filler.place === "typed") {
		return named(`${vendorNames[filler.vendor]} API key`);
	}

	return named(keyName({ place: filler.place, vendor: filler.vendor }));
};

const answering = ({
	answers,
	choice,
	id,
}: {
	readonly answers: Answers;
	readonly id: Question["id"];
	readonly choice: Choice;
}): Answers => Struct.assign(answers, { [id]: choice });

export { answering, foundScreen, keyNamed, keyPrompt, plan };

export type { Answers, Filler, Found, Kept, KeptRole, Ready, Roles, Step };
