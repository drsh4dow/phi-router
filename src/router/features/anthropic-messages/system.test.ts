import { Array, Effect, Function, Record, Schema, String as Str, Struct, pipe } from "effect";
import { assert, it } from "@effect/vitest";
import { BodyJson } from "./wire.ts";
import { Digest } from "effect/crypto";
import type { Message } from "#router/features/parts/index.ts";
import type { MessagesRequest } from "./index.ts";
import type { Target } from "#router/features/border/index.ts";
import { bridgesFor } from "#router/features/border/index.ts";
import { decodeRequest } from "./index.ts";
import { requests } from "./captures/index.ts";

const sealedStub =
	"[sealed h1] This part held patient identifiers, so phi-router withheld it. When the task needs it read, redacted or its identifiers used, hand that segment of the work to the phi-router:phi-sealed subagent with a scoped task that names h1.";

const bridge = {
	text: bridgesFor.claude,
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

	const toOpen = yield* sent(request, {
		lane: "clean",
		messages: sectionsSealed(request.messages),
		upstreamModel: target,
	});

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
	const toOpen = yield* sent(request, { lane: "clean", messages: request.messages, upstreamModel: target });

	const toBaa = yield* sent(request, {
		lane: "sealed",
		open: Function.identity,
		system: bridgesFor.claude,
		upstreamModel: target,
	});

	assert.deepStrictEqual(toOpen.system, [...(original.system ?? []), bridge]);
	assert.deepStrictEqual(toBaa.system, [...(original.system ?? []), bridge]);
});

const modelReplaced = Effect.gen(function* modelReplaced() {
	const request = yield* decodeRequest(requests.toolResult, nobodyWrote, "claude");
	const toOpen = yield* sent(request, { lane: "clean", messages: request.messages, upstreamModel: target });

	const toBaa = yield* sent(request, {
		lane: "sealed",
		open: Function.identity,
		system: bridgesFor.claude,
		upstreamModel: target,
	});

	assert.notStrictEqual(request.model, target);
	assert.strictEqual(toOpen.model, target);
	assert.strictEqual(toBaa.model, target);
});

const lookalikes = [
	"x-anthropic-billing-header: cc_version=2.1.325.a35; cc_entrypoint=cli; cc_patient=Canary.Fake;",
	"x-anthropic-billing-header: cc_version=123.45.6789.a35; cc_entrypoint=cli;",
	"x-anthropic-billing-header: cc_version=2.1.325.a35; cc_entrypoint=cli; cc_version=2.1.325.a35;",
	"x-anthropic-billing-header: cc_version=2.1.325.a35; cc_entrypoint=Canary.Fake;",
];

const sectionsOf = (request: MessagesRequest): Extract<Message, { readonly role: "system" }>["sections"] =>
	pipe(
		request.messages,
		Array.flatMap((message) => {
			if (message.role === "system") {
				return message.sections;
			}

			return [];
		}),
	);

const lookalikeSections = Effect.fnUntraced(function* lookalikeSections(text: string) {
	const body = `{"model":"m","messages":[{"role":"user","content":"hi"}],"system":[{"type":"text","text":"${text}"}],"max_tokens":10}`;
	const request = yield* decodeRequest(body, nobodyWrote, "claude");

	return sectionsOf(request);
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

const spacedSafeguards =
	'[ {"type":"dangerous_tool_use", "classifier_context":{"v":1,"live_cwd":"/tmp/WHOLE-MARKER"}} ]';

const spacedFormat = '{ "type" : "json_schema", "schema" : {"description":"WHOLE-MARKER"} }';

const wholes = `{"model":"m","messages":[{"role":"user","content":"hi"}],"safeguards":${spacedSafeguards},"output_config":{"effort":"high","format":${spacedFormat}},"max_tokens":10}`;

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
		{ description: "", name: "safeguards", parameters: spacedSafeguards },
		{ description: "", name: "output_config.format", parameters: spacedFormat },
	]);
});

it.layer(Digest.layerWebCrypto)("the system blocks and the model", (test) => {
	test.effect(
		"a first block like the attribution with any other key or value is a section, judged",
		() => lookalikeJudged,
	);

	test.effect("the attribution block stays first and unchanged when every section is stubbed", () => attributionFirst);

	test.effect("the bridge is the last system block, once, without cache_control, on both lanes", () => bridgeOnce);

	test.effect("the model is the one the upstream names, on both lanes", () => modelReplaced);

	test.effect(
		"safeguards and output_config.format are judged whole, as tool-list entries holding their source JSON",
		() => wholesJudged,
	);
});

const claudeCodeRequests = Struct.omit(requests, ["piCompaction", "piFirstTurn", "piThinkingOff", "piToolResult"]);

const attributionOfEach = Effect.gen(function* attributionOfEach() {
	for (const [name, body] of Record.toEntries(claudeCodeRequests)) {
		const request = yield* decodeRequest(body, nobodyWrote, "claude");

		assert.notInclude(
			Array.map(sectionsOf(request), (section) => section.name),
			"0",
			name,
		);
	}
});

const bridgeBlock = `{"type":"text","text":"${bridge.text}"}`;

const emptySystem = '{"model":"m","system":[],"messages":[{"role":"user","content":"hi"}],"max_tokens":10}';

const sealedOnOwnModel: Target = {
	lane: "sealed",
	open: Function.identity,
	system: bridgesFor.claude,
	upstreamModel: "m",
};

const bridgeOpensSystem = Effect.gen(function* bridgeOpensSystem() {
	const withoutSystem = yield* decodeRequest(wholes, nobodyWrote, "claude");
	const withEmptySystem = yield* decodeRequest(emptySystem, nobodyWrote, "claude");
	const toBaa = yield* withoutSystem.encode(sealedOnOwnModel);
	const toOpen = yield* withoutSystem.encode({ lane: "clean", messages: withoutSystem.messages, upstreamModel: "m" });
	const emptyToBaa = yield* withEmptySystem.encode(sealedOnOwnModel);
	const bridged = Str.replace(/\}$/u, `,"system":[${bridgeBlock}]}`)(wholes);

	assert.strictEqual(toBaa, bridged);
	assert.strictEqual(toOpen, bridged);
	assert.strictEqual(emptyToBaa, Str.replace('"system":[]', `"system":[${bridgeBlock}]`)(emptySystem));
});

it.layer(Digest.layerWebCrypto)("the system blocks of a body", (test) => {
	test.effect(
		"each captured Claude Code request's first system block is its attribution, so no section",
		() => attributionOfEach,
	);

	test.effect(
		"a body with no system blocks gets the bridge as its only one, and leaves every other byte as sent, safeguards and output_config.format included",
		() => bridgeOpensSystem,
	);
});
