import { Array, Effect, Schema, Struct, pipe } from "effect";
import { assert, it } from "@effect/vitest";
import { BodyJson } from "./wire.ts";
import { Digest } from "effect/crypto";
import type { Message } from "#router/features/parts/index.ts";
import type { MessagesRequest } from "./index.ts";
import type { Target } from "#router/features/border/index.ts";
import { decodeRequest } from "./index.ts";
import { requests } from "./captures/index.ts";

const sealedStub =
	"[withheld: holds patient identifiers, handled on the HIPAA account] The next assistant reply was written there with this content in view, so what it says about this content is accurate. Work that needs the identifiers themselves goes to the phi-router:phi-sealed subagent.";

const bridge = {
	text: "Refer to patients and members only by internal ids, such as a patient_id or a row id, never by name, SSN, date of birth, address, phone, email, member number or record number. A message shown as [withheld: holds patient identifiers, handled on the HIPAA account] was handled on the HIPAA account. When the newest user message holds patient identifiers, open your reply by restating what was asked without them, because later requests will not include that message. When the work cannot be done without the identifiers themselves, hand it to the phi-router:phi-sealed subagent and put the identifiers it needs in its prompt, because it cannot see this conversation.",
	type: "text",
} as const;

const target = "claude-target";

const nobodyWrote = (): boolean => false;

const decodeBody = Schema.decodeEffect(BodyJson);

const sent = Effect.fnUntraced(function* sent(request: MessagesRequest, upstream: Target) {
	const body = yield* request.encode(upstream);

	return yield* decodeBody(body, { onExcessProperty: "error" });
});

const sectionsSealed = (messages: readonly Message[]): readonly Message[] =>
	pipe(
		messages,
		Array.map((message): Message => {
			if (message.role !== "system") {
				return message;
			}

			const sections = pipe(
				message.sections,
				Array.map(({ name }) => ({ name, text: sealedStub })),
			);

			return { content: message.content, role: "system", sections, tools: message.tools };
		}),
	);

const attributionFirst = Effect.gen(function* attributionFirst() {
	const request = yield* decodeRequest(requests.toolResult, nobodyWrote, "claude");
	const original = yield* decodeBody(requests.toolResult);
	const toOpen = yield* sent(request, { lane: "clean", messages: sectionsSealed(request.messages), model: target });

	const expected = pipe(
		original.system ?? [],
		Array.matchLeft({
			onEmpty: () => [bridge],
			onNonEmpty: (attribution, sections) => [
				attribution,
				...pipe(
					sections,
					Array.map((block) => Struct.assign(block, { text: sealedStub })),
				),
				bridge,
			],
		}),
	);

	assert.deepStrictEqual(toOpen.system, expected);
});

const bridgeOnce = Effect.gen(function* bridgeOnce() {
	const request = yield* decodeRequest(requests.toolResult, nobodyWrote, "claude");
	const original = yield* decodeBody(requests.toolResult);
	const toOpen = yield* sent(request, { lane: "clean", messages: request.messages, model: target });
	const toBaa = yield* sent(request, { lane: "sealed", model: target, pinned: false });
	const pinned = yield* sent(request, { lane: "sealed", model: target, pinned: true });

	assert.deepStrictEqual(toOpen.system, [...(original.system ?? []), bridge]);
	assert.deepStrictEqual(toBaa.system, [...(original.system ?? []), bridge]);
	assert.deepStrictEqual(pinned.system, original.system);
});

const modelReplaced = Effect.gen(function* modelReplaced() {
	const request = yield* decodeRequest(requests.toolResult, nobodyWrote, "claude");
	const toOpen = yield* sent(request, { lane: "clean", messages: request.messages, model: target });
	const toBaa = yield* sent(request, { lane: "sealed", model: target, pinned: true });

	assert.notStrictEqual(request.model, target);
	assert.strictEqual(toOpen.model, target);
	assert.strictEqual(toBaa.model, target);
});

/** First blocks that read like attribution but hold more than Claude Code was recorded sending. */
const lookalikes = [
	"x-anthropic-billing-header: cc_version=2.1.325.a35; cc_entrypoint=cli; cc_patient=Canary.Fake;",
	"x-anthropic-billing-header: cc_version=123.45.6789.a35; cc_entrypoint=cli;",
	"x-anthropic-billing-header: cc_version=2.1.325.a35; cc_entrypoint=cli; cc_version=2.1.325.a35;",
	"x-anthropic-billing-header: cc_version=2.1.325.a35; cc_entrypoint=Canary.Fake;",
];

const lookalikeSections = Effect.fnUntraced(function* lookalikeSections(text: string) {
	const body = `{"model":"m","messages":[{"role":"user","content":"hi"}],"system":[{"type":"text","text":"${text}"}],"max_tokens":10}`;
	const request = yield* decodeRequest(body, nobodyWrote, "claude");

	return pipe(
		request.messages,
		Array.flatMap((message) => {
			if (message.role === "system") {
				return message.sections;
			}

			return [];
		}),
	);
});

const lookalikeJudged = Effect.gen(function* lookalikeJudged() {
	const sections = yield* Effect.forEach(lookalikes, lookalikeSections, { concurrency: 1 });

	assert.deepStrictEqual(
		sections,
		pipe(
			lookalikes,
			Array.map((text) => [{ name: "0", text }]),
		),
	);
});

/** The source JSON of two fields the codec cannot read part by part, spaced as no encoder would write them. */
const safeguards = '[ {"type":"dangerous_tool_use", "classifier_context":{"v":1,"live_cwd":"/tmp/WHOLE-MARKER"}} ]';

const format = '{ "type" : "json_schema", "schema" : {"description":"WHOLE-MARKER"} }';

const wholes = `{"model":"m","messages":[{"role":"user","content":"hi"}],"safeguards":${safeguards},"output_config":{"effort":"high","format":${format}},"max_tokens":10}`;

const wholesJudged = Effect.gen(function* wholesJudged() {
	const request = yield* decodeRequest(wholes, nobodyWrote, "claude");

	const tools = pipe(
		request.messages,
		Array.flatMap((message) => {
			if (message.role === "system") {
				return message.tools;
			}

			return [];
		}),
	);

	assert.deepStrictEqual(tools, [
		{ description: "", name: "safeguards", parameters: safeguards },
		{ description: "", name: "output_config.format", parameters: format },
	]);
});

it.layer(Digest.layerWebCrypto)("the system blocks and the model", (test) => {
	test.effect(
		"a first block like the attribution with any other key or value is a section, judged",
		() => lookalikeJudged,
	);

	test.effect("the attribution block stays first and unchanged when every section is stubbed", () => attributionFirst);

	test.effect(
		"the bridge is the last system block, once, without cache_control, unless the request is pinned",
		() => bridgeOnce,
	);

	test.effect("the model is the one the upstream names, on both lanes", () => modelReplaced);

	test.effect(
		"safeguards and output_config.format are judged whole, as tool-list entries holding their source JSON",
		() => wholesJudged,
	);
});
