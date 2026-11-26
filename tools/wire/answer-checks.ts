import { Array, Effect, FileSystem, Number, Option, Path, String as Str, Stream, pipe } from "effect";
import type { Asked, Reply, Said, Sent } from "#router/client/mock-upstreams/index.ts";
import { handOff, isSubagent, subagent } from "./phi-checks.ts";
import { identifierKind, rewriteLimit } from "#router/features/policy/index.ts";
import { sealingWhen, textEvents, toolEvents } from "#router/client/mock-upstreams/index.ts";
import type { Check } from "./checks.ts";
import { isModelPost } from "./stored.ts";
import { rewriteExit } from "#router/features/cli/index.ts";
import { succeeded } from "./checks.ts";
import { voidedSsn } from "./cases.ts";

const chart = "planted-chart.txt";

const readChart = `Read the file ${chart} and tell me what it says.`;

const cleanAnswer = "The member's internal id is p-17.";

const judgedName = "Quillon Marchbanks";

const listFile = "member.txt";

const once = 1;

const timesIn = (text: string, part: string): number => Str.split(text, part).length - once;

const said = (texts: readonly string[]): Said => ({ events: Stream.fromIterable(textEvents(texts)), kind: "events" });

interface Call {
	readonly id: string;
	readonly name: string;
	readonly input: string;
}

const calling = (call: Call): Said => ({ events: Stream.fromIterable(toolEvents(call)), kind: "events" });

const resultOf = (id: string): string => `"tool_use_id":"${id}"`;

const rewritten = (body: string): boolean => Str.includes("This is rewrite attempt")(body);

const filesFolder = /(?<=new file in )\/\S+(?= with mode 0600)/u;

const listedPath = /\/\S+\/phi-router\/files\/[\w-]+\/member\.txt/u;

interface Task {
	readonly id: string;
	readonly asks: string;
	readonly task: string;
	readonly answers: (asked: Asked) => Said;
}

interface Tasks {
	readonly lookUp: Task;
	readonly lookUpAgain: Task;
	readonly judged: Task;
	readonly withheld: Task;
	readonly toolFirst: Task;
	readonly listed: Task;
}

const untilRewritten =
	(first: string, later: string) =>
	({ body }: Asked): Said => {
		if (rewritten(body)) {
			return said([later]);
		}

		return said([first]);
	};

const readsFirst =
	(file: string) =>
	({ body }: Asked): Said => {
		const read = { id: "toolu_wire_sub_read", input: `{"file_path":"${file}"}`, name: "Read" };

		if (Str.includes(resultOf(read.id))(body)) {
			return said([cleanAnswer]);
		}

		return calling(read);
	};

const writesList = ({ body }: Asked): Said => {
	const write = "toolu_wire_sub_write";

	const file = pipe(
		Str.match(filesFolder)(body),
		Option.map(([folder]) => `${folder}/${listFile}`),
		Option.getOrElse(() => listFile),
	);

	if (Str.includes(resultOf(write))(body)) {
		return said([`I wrote the member's name and SSN to ${file}.`]);
	}

	const command = `umask 077 && printf 'Member SSN: ${voidedSsn}\\\\n' > ${file}`;

	return calling({ id: write, input: `{"command":"${command}","description":"Write the member list"}`, name: "Bash" });
};

const tasksFor = (file: string): Tasks => ({
	judged: {
		answers: untilRewritten(`The caller was ${judgedName}.`, "The caller was the member, p-17."),
		asks: "Ask the pinned subagent who called about the member.",
		id: "toolu_wire_agent_judged",
		task: "Say who called about the member.",
	},
	listed: {
		answers: writesList,
		asks: "Have the pinned subagent put the member's SSN in a file for the claims team.",
		id: "toolu_wire_agent_listed",
		task: "Write the member's SSN to a file for the user.",
	},
	lookUp: {
		answers: untilRewritten(subagent.answer, cleanAnswer),
		asks: handOff,
		id: "toolu_wire_agent",
		task: subagent.prompt,
	},
	lookUpAgain: {
		answers: () => said([cleanAnswer]),
		asks: "Ask the pinned subagent for that member's internal id once more.",
		id: "toolu_wire_agent_again",
		task: "Find the member's internal id once more.",
	},
	toolFirst: {
		answers: readsFirst(file),
		asks: "Ask the pinned subagent to read the chart before it answers.",
		id: "toolu_wire_agent_tool_first",
		task: "Read the chart file, then find the member's internal id.",
	},
	withheld: {
		answers: () => said([subagent.answer]),
		asks: "Ask the pinned subagent for the member's SSN.",
		id: "toolu_wire_agent_withheld",
		task: "Give the member's SSN.",
	},
});

const tasksIn = (tasks: Tasks): readonly Task[] => [
	tasks.lookUp,
	tasks.lookUpAgain,
	tasks.judged,
	tasks.withheld,
	tasks.toolFirst,
	tasks.listed,
];

const agentCall = ({ id, task }: Task): Said =>
	calling({
		id,
		input: `{"description":"Hand off the segment that needs PHI","prompt":"${task} The member is in h1.","run_in_background":false,"subagent_type":"phi-router:phi-sealed"}`,
		name: "Agent",
	});

const listReported = (tasks: Tasks, { last }: Asked): Option.Option<Said> => {
	const listedResult = Str.includes(resultOf(tasks.listed.id));

	return pipe(
		Option.liftPredicate(last, listedResult),
		Option.flatMap(Str.match(listedPath)),
		Option.map(([path]) => said([`The member list is in ${path}.`])),
	);
};

const handingOff = (tasks: Tasks, { body }: Asked): Option.Option<Said> =>
	pipe(
		tasksIn(tasks),
		Array.findFirst(({ asks, id }) => Str.includes(asks)(body) && !Str.includes(id)(body)),
		Option.map(agentCall),
	);

const openScriptOf = ({ file, tasks }: { readonly file: string; readonly tasks: Tasks }): ((asked: Asked) => Said) => {
	const read = { id: "toolu_wire_read", input: `{"file_path":"${file}"}`, name: "Read" };

	return (asked) => {
		if (Str.includes(readChart)(asked.body) && !Str.includes(read.id)(asked.body)) {
			return calling(read);
		}

		return pipe(
			listReported(tasks, asked),
			Option.orElse(() => handingOff(tasks, asked)),
			Option.getOrElse(() => said(["ok"])),
		);
	};
};

const baaScriptOf =
	(tasks: Tasks) =>
	(asked: Asked): Said => {
		if (!isSubagent(asked)) {
			return said(["ok"]);
		}

		return pipe(
			tasksIn(tasks),
			Array.findFirst(({ task }) => Str.includes(task)(asked.body)),
			Option.match({ onNone: () => said(["ok"]), onSome: ({ answers }) => answers(asked) }),
		);
	};

const certain = 1;

const judgeOf =
	(holdsPhi: (piece: string) => boolean) =>
	(piece: string): Reply => {
		if (!Str.includes(judgedName)(piece)) {
			return sealingWhen(holdsPhi)(piece);
		}

		const kind = {
			choice: identifierKind.patientName,
			confidence: certain,
			name: "kind",
			probabilities: [],
			type: "choice",
		};

		return {
			body: { answers: [{ name: "identifier", probability: certain, type: "predicate" }, kind], usage: {} },
			kind: "body",
		};
	};

interface Listed {
	readonly file: string;
	readonly mode: number;
	readonly text: string;
}

const permissionBits = 0o1000;

const listedIn = Effect.fnUntraced(function* listedIn(state: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const files = path.join(state, "files");
	const names = yield* fs.readDirectory(files, { recursive: true });

	const read = Effect.fnUntraced(function* read(name: string) {
		const file = path.join(files, name);
		const info = yield* fs.stat(file);

		if (info.type !== "File") {
			return Option.none<Listed>();
		}

		const text = yield* fs.readFileString(file);

		return Option.some({ file, mode: info.mode % permissionBits, text });
	});

	const listed = yield* Effect.forEach(names, read, { concurrency: 1 });

	return Array.getSomes(listed);
});

interface PinnedTurn {
	readonly printed: string;
	readonly open: readonly Sent[];
	readonly baa: readonly Sent[];
}

interface Rewritten {
	readonly ids: Readonly<Record<keyof Tasks, string>>;
	readonly handedOff: PinnedTurn;
	readonly reopened: PinnedTurn;
	readonly judged: PinnedTurn;
	readonly withheld: PinnedTurn;
	readonly toolFirst: PinnedTurn;
	readonly listed: PinnedTurn;
	readonly status: PinnedTurn;
	readonly all: readonly PinnedTurn[];
	readonly files: readonly Listed[];
	readonly canaries: readonly string[];
}

const answersBeforeGivingUp = rewriteLimit + once;

const privateMode = 0o600;

const readThenAnswer = 2;

const subagentExits = /(?<="hook_name":"SubagentStop".*"exit_code":)\d+/gu;

const exitsOf = ({ printed }: PinnedTurn): string =>
	pipe(
		Array.fromIterable(Str.matchAll(subagentExits)(printed)),
		Array.map(([code]) => code),
		Array.join(","),
	);

const exitsWere = (codes: readonly number[]): string => pipe(codes, Array.map(String), Array.join(","));

const subagentAsks = (turn: PinnedTurn): readonly string[] =>
	pipe(
		turn.baa,
		Array.filter((sent) => isModelPost(sent) && isSubagent(sent)),
		Array.map(({ body }) => body),
	);

const secondAsk = (turn: PinnedTurn): string =>
	pipe(
		subagentAsks(turn),
		Array.get(once),
		Option.getOrElse(() => ""),
	);

const resultIn = (turn: PinnedTurn, id: string): string =>
	pipe(
		turn.open,
		Array.findFirst((sent) => isModelPost(sent) && Str.includes(`"tool_use_id":"${id}"`)(sent.body)),
		Option.match({ onNone: () => "", onSome: ({ body }) => body }),
	);

const resultLine = /^.*"type":"result".*$/mu;

const rootReport = ({ printed }: PinnedTurn): string =>
	pipe(Str.match(resultLine)(printed), Option.match({ onNone: () => "", onSome: ([line]) => line }));

const noticeWords = "pinned subagent answer still held patient identifiers after 5 rewrites";

const noticesIn = ({ printed }: PinnedTurn): number =>
	pipe(
		Str.split(printed, "\n"),
		Array.filter((line) => !Str.includes('"subtype":"hook_')(line)),
		Array.map((line) => timesIn(line, noticeWords)),
		Number.sumAll,
	);

const holdsAll =
	(texts: readonly string[]) =>
	(body: string): boolean =>
		pipe(
			texts,
			Array.every((text) => Str.includes(text)(body)),
		);

const holdsAny =
	(texts: readonly string[]) =>
	(body: string): boolean =>
		pipe(
			texts,
			Array.some((text) => Str.includes(text)(body)),
		);

const firstRewrite = (reason: string): readonly string[] => [
	`phi-router withheld your last answer: ${reason}`,
	"This is rewrite attempt 1 of 5: answer again without them.",
	"Refer to each person by an internal id",
	"give counts instead of lists of people",
	"/phi-router/files/",
];

const withheldReply =
	/\[sealed h\d+\] The pinned subagent's answer still held patient identifiers after 5 rewrites, so phi-router could not clear it and withheld it\. h\d+ is its handle\./u;

const opensNone = (texts: readonly string[], turns: readonly PinnedTurn[]): boolean =>
	!pipe(
		turns,
		Array.flatMap(({ open }) => open),
		Array.some(({ body }) => holdsAny(texts)(body)),
	);

const listedChecks = ({ canaries, files, ids, listed }: Rewritten): boolean => {
	const report = rootReport(listed);
	const handedBack = resultIn(listed, ids.listed);

	return Array.match(files, {
		onEmpty: () => false,
		onNonEmpty: ([written, ...others]) =>
			!Array.isReadonlyArrayNonEmpty(others) &&
			Str.endsWith(`/${listFile}`)(written.file) &&
			written.mode === privateMode &&
			Str.includes(voidedSsn)(written.text) &&
			Str.includes(written.file)(handedBack) &&
			Str.includes(written.file)(report) &&
			!holdsAny(canaries)(report) &&
			opensNone(canaries, [listed]),
	});
};

const answerChecksOf = (played: Rewritten): readonly Check[] => {
	const { ids } = played;
	const lookedUp = resultIn(played.handedOff, ids.lookUp);
	const judged = resultIn(played.judged, ids.judged);

	const ssnRewrite = firstRewrite(
		`it holds a Social Security number (${identifierKind.socialSecurityNumber}): \\"${voidedSsn}\\"`,
	);

	const judgeRewrite = firstRewrite(
		`phi-router's judge scored it 1.00 for holding a direct identifier of a patient or member, most likely a real patient's or member's name (${identifierKind.patientName})`,
	);

	return [
		{
			name: "AC8: a clean answer reaches the open mock unchanged in the root agent's next request, after one subagent request and no notice",
			ok:
				Str.includes(cleanAnswer)(resultIn(played.reopened, ids.lookUpAgain)) &&
				subagentAsks(played.reopened).length === once &&
				noticesIn(played.reopened) < once,
		},
		{
			name: "AC9: a rule hit comes back to the subagent naming the kind and the quoted value, attempt 1 of 5 and the way out, and the root agent gets only the rewritten answer",
			ok:
				holdsAll(ssnRewrite)(secondAsk(played.handedOff)) &&
				Str.includes(cleanAnswer)(lookedUp) &&
				!Str.includes(voidedSsn)(lookedUp),
		},
		{
			name: "AC9: a judge seal comes back to the subagent naming the kind and the score, attempt 1 of 5 and the way out, and the open mock never gets the name",
			ok:
				holdsAll(judgeRewrite)(secondAsk(played.judged)) &&
				Str.includes("The caller was the member, p-17.")(judged) &&
				opensNone([judgedName], played.all),
		},
		{
			name: "AC11: after 5 rewrites the root agent gets the answer's handle and the could-not-be-cleared line, never the canary",
			ok:
				subagentAsks(played.withheld).length === answersBeforeGivingUp &&
				withheldReply.test(resultIn(played.withheld, ids.withheld)) &&
				opensNone(played.canaries, [played.withheld]),
		},
		{
			name: "AC11: the turn that withheld an answer shows one notice, and no other turn shows one",
			ok: noticesIn(played.withheld) === once && pipe(played.all, Array.map(noticesIn), Number.sumAll) === once,
		},
		{
			name: "AC13: one SubagentStop answer check runs per answer, exit 2 for each rewrite, and none for the subagent's tool call",
			ok:
				exitsOf(played.handedOff) === exitsWere([rewriteExit, succeeded]) &&
				exitsOf(played.withheld) === exitsWere([...Array.replicate(rewriteExit, rewriteLimit), succeeded]) &&
				subagentAsks(played.toolFirst).length === readThenAnswer &&
				exitsOf(played.toolFirst) === exitsWere([succeeded]),
		},
		{
			name: "AC14: the subagent writes the identifiers to a 0600 file in the session's files folder, the root agent reports its absolute path and no canary, and the file outlives the router",
			ok: listedChecks(played),
		},
		{
			name: "AC17: /phi shows the pinned subagent's runs, one per subagent started, its rewrites and its withheld answers",
			ok: Str.includes("Pinned subagent: 6 runs, 7 rewrites, 1 answer withheld")(played.status.printed),
		},
	];
};

export {
	answerChecksOf,
	baaScriptOf,
	calling,
	chart,
	judgeOf,
	listedIn,
	openScriptOf,
	readChart,
	resultOf,
	rewritten,
	said,
	tasksFor,
};
