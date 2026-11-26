import { Array, Effect, Function, Option, String as Str, Struct, pipe } from "effect";
import type { Asked, Said } from "#router/client/mock-upstreams/index.ts";
import { calling, resultOf, said } from "./answer-checks.ts";
import { delegated, lookUp, overdueFile, overdueId, quote } from "./account-turns.ts";
import { mocked } from "#tools/route/mocked-router.ts";
import { voidedSsn } from "./cases.ts";

interface Task {
	readonly prompt: string;
	readonly name: string;
	readonly asks: string;
}

const tasks: readonly Task[] = [
	{ asks: "Find the patient_id of the overdue payment", name: "look_up", prompt: lookUp },
	{ asks: "Quote exactly as written the claim reference of the overdue payment", name: "quote", prompt: quote },
	{ asks: "Find the patient_id of the overdue payment", name: "delegated_look_up", prompt: delegated },
];

const securityMonitor = "You are a security monitor";

const harmless =
	'{"content":[{"text":"<severity>0</severity>","type":"text"}],"id":"msg_monitor","model":"mock","role":"assistant","stop_reason":"end_turn","type":"message","usage":{"input_tokens":1,"output_tokens":1}}';

const answered = 200;

const stub = /\[sealed (?<handle>h\d+)\]/u;

interface Root {
	readonly read: { readonly name: string; readonly input: string };
	readonly handOff: (task: Task, handle: string) => { readonly name: string; readonly input: string };
}

const claudeRoot: Root = {
	handOff: (task, handle) => ({
		input: `{"description":"Read the sealed record","prompt":"${task.asks} in ${handle}.","subagent_type":"phi-router:phi-sealed"}`,
		name: "Agent",
	}),
	read: { input: `{"command":"cat ${overdueFile}","description":"Read the file"}`, name: "Bash" },
};

const piHarnessRoot: Root = {
	handOff: (task, handle) => ({
		input: `{"goal":"Name the overdue payment","message":"${task.asks} in ${handle}.","model":"phi/sealed","name":"overdue reader","role":"leaf"}`,
		name: "delegate",
	}),
	read: { input: `{"path":"${overdueFile}"}`, name: "read" },
};

const rootTurn = (root: Root, task: Task, { body, last }: Asked): Said => {
	const read = `toolu_acc_read_${task.name}`;
	const handOff = `toolu_acc_hand_off_${task.name}`;

	if (!Str.includes(resultOf(read))(body)) {
		return calling(Struct.assign(root.read, { id: read }));
	}

	if (Str.includes(resultOf(handOff))(body)) {
		return said([`The pinned subagent returned: ${last}`]);
	}

	const sealedHandle = pipe(
		Option.fromNullishOr(stub.exec(last)),
		Option.flatMapNullishOr(({ groups }) => groups),
		Option.flatMapNullishOr(({ handle }) => handle),
	);

	return Option.match(sealedHandle, {
		onNone: () => said([`The file says: ${last}`]),
		onSome: (handle) => calling(Struct.assign(root.handOff(task, handle), { id: handOff })),
	});
};

const openScript =
	(root: Root) =>
	(asked: Asked): Said => {
		if (Str.includes(securityMonitor)(asked.body)) {
			return { body: harmless, kind: "status", status: answered };
		}

		return pipe(
			tasks,
			Array.findFirst(({ prompt }) => Str.includes(prompt)(asked.body)),
			Option.match({ onNone: () => said(["ok"]), onSome: (task) => rootTurn(root, task, asked) }),
		);
	};

const handBackTool = '"name":"SubagentHandback"';

const handedBack = "toolu_acc_handback_";

const rewritten = "This is rewrite attempt";

const answerOf = (task: Task, { body }: Asked): string => {
	if (task.name === "look_up") {
		return `The overdue payment is ${overdueId}.`;
	}

	if (Str.includes(rewritten)(body) && !Str.includes(handBackTool)(body)) {
		return `I cannot quote it. The overdue payment is ${overdueId}.`;
	}

	if (Str.includes(voidedSsn)(body)) {
		return `The claim reference is ${voidedSsn}.`;
	}

	return "I found no claim reference.";
};

const once = 1;

const subagentTurn = (task: Task, asked: Asked): Said => {
	const answer = answerOf(task, asked);

	if (!Str.includes(handBackTool)(asked.body)) {
		return said([answer]);
	}

	if (Str.includes(handedBack)(asked.last) && !Str.includes('"is_error":true')(asked.last)) {
		return said(["Handed back."]);
	}

	const attempt = Str.split(asked.body, `"tool_use_id":"${handedBack}`).length;

	return calling({
		id: `${handedBack}${String(attempt + once)}`,
		input: `{"message":"${answer}"}`,
		name: "SubagentHandback",
	});
};

const baaScript = (asked: Asked): Said =>
	pipe(
		tasks,
		Array.findFirst(({ asks }) => Str.includes(asks)(asked.body)),
		Option.match({ onNone: () => said(["ok"]), onSome: (task) => subagentTurn(task, asked) }),
	);

const priced = { sealedModel: { anthropic: "claude-haiku-5-5", openai: "gpt-6-luna" } };

const scripted = {
	claude: { harness: "claude", root: Option.some(claudeRoot) },
	codex: { harness: "codex", root: Option.none() },
	pi: { harness: "pi", root: Option.none() },
	"pi-harness": { harness: "pi", root: Option.some(piHarnessRoot) },
} as const satisfies Record<
	string,
	{ readonly harness: "claude" | "codex" | "pi"; readonly root: Option.Option<Root> }
>;

const mockedAccounts = Effect.fnUntraced(function* mockedAccounts(harness: keyof typeof scripted) {
	const { harness: served, root } = scripted[harness];
	const common = { configExtras: priced, harness: served, holdsPhi: Function.constFalse };

	const scripts = Option.match(root, {
		onNone: () => common,
		onSome: (playing) => Struct.assign(common, { baa: baaScript, open: openScript(playing) }),
	});

	const router = yield* mocked(scripts);

	return {
		configHome: router.env.XDG_CONFIG_HOME,
		env: {
			PHI_ACCOUNTS_OFFLINE: "1",
			PHI_TEST_BAA_KEY: router.env.PHI_TEST_BAA_KEY,
			PHI_TEST_JUDGE_KEY: router.env.PHI_TEST_JUDGE_KEY,
		},
	};
});

export { mockedAccounts };
