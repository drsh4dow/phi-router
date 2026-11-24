import { Array, Effect, Schema, String as Str, Stream, Struct, pipe } from "effect";
import type { Asked, Json, Said, Sent } from "#router/client/mock-upstreams/index.ts";
import { assert, it } from "@effect/vitest";
import { codexBodyOf, fakes, headersNamed, jsonText, replyMessage, replying, userMessage } from "./harnesses.ts";
import { laneLines, postedIn, routed } from "./mocked-router.ts";
import { NodeServices } from "@effect/platform-node";
import { responseEvents } from "#router/client/mock-upstreams/index.ts";

const canary = "PATIENT-CANARY-8R2M";

const holdsCanary = Str.includes(canary);

const ok = 200;

const once = 1;

const phiText = `Member ${canary} called.`;

/** The Claude Code bridge, with Codex's subagent `phi-sealed`. */
const bridge =
	"Refer to patients and members only by internal ids, such as a patient_id or a row id, never by name, SSN, date of birth, address, phone, email, member number or record number. A message shown as [withheld: holds patient identifiers, handled on the HIPAA account] was handled on the HIPAA account. When the newest user message holds patient identifiers, open your reply by restating what was asked without them, because later requests will not include that message. When the work cannot be done without the identifiers themselves, hand it to the phi-sealed subagent and put the identifiers it needs in its prompt, because it cannot see this conversation.";

/** The Claude Code stub, with Codex's subagent `phi-sealed`. */
const stub =
	"[withheld: holds patient identifiers, handled on the HIPAA account] The next assistant reply was written there with this content in view, so what it says about this content is accurate. Work that needs the identifiers themselves goes to the phi-sealed subagent.";

const items = {
	clean: userMessage("List the build steps."),
	followUp: userMessage("Go on."),
	noted: replyMessage({ id: "msg_baa", text: "noted" }),
	ok: replyMessage({ id: "msg_open_ok", text: "ok" }),
	phi: { content: [{ text: phiText, type: "input_text" }], id: "msg_phi", role: "user", type: "message" },
} as const satisfies Record<string, Json>;

const Body = Schema.fromJsonString(
	Schema.Struct({ input: Schema.Array(Schema.Json), instructions: Schema.String, model: Schema.String }),
);

const shown = ["authorization", "chatgpt-account-id"];

/** What a test reads of one request an account mock received. */
const viewOf = Effect.fnUntraced(function* viewOf(sent: Sent) {
	const { input, instructions, model } = yield* Schema.decodeEffect(Body)(sent.body);

	return { canary: holdsCanary(sent.body), headers: headersNamed(shown)(sent.headers), input, instructions, model };
});

const viewsOf = (
	received: readonly Sent[],
): Effect.Effect<readonly Effect.Success<ReturnType<typeof viewOf>>[], Schema.SchemaError> =>
	Effect.forEach(received, (sent) => viewOf(sent), { concurrency: 1 });

const sentAs = { instructions: bridge, model: fakes.targetModel };

const open = { authorization: `Bearer ${fakes.harnessToken}`, "chatgpt-account-id": fakes.accountId };

const conversation = [
	[items.clean],
	[items.clean, items.ok, items.phi],
	[items.clean, items.ok, items.phi, items.noted, items.followUp],
] as const;

const stubbed = Struct.assign(items.phi, { content: [{ text: stub, type: "input_text" }] });

const expectedLanes = {
	breaches: [],
	lines: [
		["open", "clean", "clean"],
		["baa", "sealed", "sealed new content"],
		["open", "clean", "clean"],
	],
	opened: [
		Struct.assign(sentAs, { canary: false, headers: open, input: [items.clean] }),
		Struct.assign(sentAs, {
			canary: false,
			headers: open,
			input: [items.clean, items.ok, stubbed, items.noted, items.followUp],
		}),
	],
	sealed: [
		Struct.assign(sentAs, {
			canary: true,
			headers: { authorization: `Bearer ${fakes.baaKey}` },
			input: [items.clean, items.ok, items.phi],
		}),
	],
	statuses: [ok, ok, ok],
};

const lanes = Effect.gen(function* lanes() {
	const { breaches, mocks, post, state } = yield* routed({
		baa: () => replying([items.noted]),
		harness: "codex",
		holdsPhi: holdsCanary,
	});

	const statuses = yield* Effect.forEach(conversation, (input) => postedIn(post, "codex-1", input), {
		concurrency: 1,
	});

	const opened = yield* mocks.open.received.pipe(Effect.flatMap(viewsOf));
	const sealed = yield* mocks.baa.received.pipe(Effect.flatMap(viewsOf));
	const lines = yield* laneLines(state);

	const logged = pipe(
		lines,
		Array.map(({ account, lane, reason }) => [account, lane, reason]),
	);

	const found = yield* breaches;

	assert.deepStrictEqual<unknown>({ breaches: found, lines: logged, opened, sealed, statuses }, expectedLanes);
});

const call = {
	arguments: '{"cmd":"cat notes.txt"}',
	call_id: "call_notes",
	name: "exec_command",
	type: "function_call",
} as const;

const output = { call_id: "call_notes", output: phiText, type: "function_call_output" } as const;

const toolResult = Effect.gen(function* toolResult() {
	const { mocks, post } = yield* routed({
		baa: () => replying([items.noted]),
		harness: "codex",
		holdsPhi: holdsCanary,
	});

	const asked = [userMessage("Read the notes."), call, output];

	const statuses = yield* Effect.forEach(
		[asked, [...asked, items.noted, items.followUp]],
		(input) => postedIn(post, "codex-2", input),
		{ concurrency: 1 },
	);

	const opened = yield* mocks.open.received.pipe(Effect.flatMap(viewsOf));
	const sealed = yield* mocks.baa.received;

	const inputs = pipe(
		opened,
		Array.map(({ input }) => input),
	);

	const stubbedOutput = Struct.assign(output, { output: stub });

	assert.deepStrictEqual<unknown>(
		{ inputs, sealed: sealed.length, statuses },
		{
			inputs: [[userMessage("Read the notes."), call, stubbedOutput, items.noted, items.followUp]],
			sealed: once,
			statuses: [ok, ok],
		},
	);
});

const blob = "gAAAAABopen-reasoning-blob-0001";

const reasoning = { encrypted_content: blob, id: "rs_open", summary: [], type: "reasoning" } as const;

/**
 * The open account's reply: a reasoning item, then text. "Think briefly." gets it cut before `response.completed`.
 *
 * @param {Asked} asked What the account is asked.
 * @returns {Said} The reply.
 */
const thinking = ({ last }: Asked): Said => {
	const events = responseEvents([reasoning, items.ok]);

	if (Str.includes("Think briefly.")(last)) {
		return { events: Stream.fromIterable(Array.dropRight(events, once)), kind: "events" };
	}

	return { events: Stream.fromIterable(events), kind: "events" };
};

const carriesBlob = (sent: Sent): boolean => Str.includes(blob)(sent.body);

const echo = (asked: string): readonly Json[] => [userMessage(asked), reasoning, items.ok, items.followUp];

const replyKeys = Effect.gen(function* replyKeys() {
	const { mocks, post } = yield* routed({ harness: "codex", holdsPhi: holdsCanary, open: thinking });

	yield* postedIn(post, "codex-3a", [userMessage("Think.")]);
	yield* postedIn(post, "codex-3a", echo("Think."));
	yield* postedIn(post, "codex-3b", echo("Think."));
	yield* postedIn(post, "codex-3c", [userMessage("Think briefly.")]);
	yield* postedIn(post, "codex-3c", echo("Think briefly."));

	const opened = yield* mocks.open.received;

	assert.deepStrictEqual(pipe(opened, Array.map(carriesBlob)), [false, true, false, false, false]);
});

const baaReasoning = Effect.gen(function* baaReasoning() {
	const { mocks, post } = yield* routed({
		baa: () => replying([reasoning, items.noted]),
		harness: "codex",
		holdsPhi: holdsCanary,
	});

	yield* postedIn(post, "codex-4", [items.phi]);
	yield* postedIn(post, "codex-4", [items.phi, reasoning, items.noted, items.followUp]);

	const opened = yield* mocks.open.received;
	const sealed = yield* mocks.baa.received;

	assert.deepStrictEqual(
		{ opened: pipe(opened, Array.map(carriesBlob)), sealed: sealed.length },
		{ opened: [false], sealed: once },
	);
});

const review = "codex-auto-review";

const namedModel = Effect.gen(function* namedModel() {
	const { mocks, post } = yield* routed({ harness: "codex", holdsPhi: holdsCanary });
	const body = yield* codexBodyOf([userMessage("Review the diff.")]);
	const response = yield* post({ body: Str.replace("phi/auto", review)(body), session: "codex-5" });

	yield* response.text;

	const opened = yield* mocks.open.received.pipe(Effect.flatMap(viewsOf));

	const judged = yield* mocks.judge.received.pipe(
		Effect.map(Array.map(({ body: asked }) => asked)),
		Effect.flatMap(jsonText),
	);

	const models = pipe(
		opened,
		Array.map(({ model }) => model),
	);

	assert.deepStrictEqual(
		{ judged: Str.includes("Review the diff.")(judged), models },
		{ judged: true, models: [review] },
	);
});

it.layer(NodeServices.layer)("Codex over HTTP", (test) => {
	test.effect(
		"clean goes open with the bridge, a canary goes to the BAA account, and the follow-up carries the stub",
		() => lanes,
	);
	test.effect(
		"a canary in a tool result goes sealed, and the open account then gets the stub with its call",
		() => toolResult,
	);
	test.effect("reasoning goes back open only in the session whose open reply completed with it", () => replyKeys);
	test.effect("reasoning a BAA reply wrote never reaches the open account", () => baaReasoning);
	test.effect("a model other than phi/auto is judged and kept", () => namedModel);
});
