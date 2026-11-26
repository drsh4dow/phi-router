import { Array, Effect, FileSystem, Path, String as Str, pipe } from "effect";
import type { Post, Turn } from "./mocked-router.ts";
import { assert, it } from "@effect/vitest";
import { bodyOf, laneLines, routed } from "./mocked-router.ts";
import { Base64Url } from "effect/encoding";
import { NodeServices } from "@effect/platform-node";
import { handleAt } from "#router/primitives/handle.ts";
import { jsonText } from "./harnesses.ts";
import { pinnedModel } from "#router/features/lanes/index.ts";
import { sealedStub } from "#router/features/border/index.ts";

const secondSequence = 2;

const h2 = handleAt(secondSequence);

const secondRequest = 1;

const requestsPosted = 4;

const permissionBits = 0o1000;

const canaries = { first: "CANARY-PAT-4471", second: "CANARY-PAT-9050" } as const;

const holdsCanary = Str.includes("CANARY-PAT");

const firstAsk: Turn = { role: "user", text: `Member ${canaries.first} called about claim 88123.` };

const secondAsk: Turn = { role: "user", text: `Member ${canaries.second} called too.` };

const conversation: readonly (readonly Turn[])[] = [
	[firstAsk],
	[firstAsk, { role: "assistant", text: "Noted." }, secondAsk],
	[firstAsk, { role: "assistant", text: "Noted." }, secondAsk, { role: "assistant", text: "Noted." }, firstAsk],
];

const postAll = Effect.fnUntraced(function* postAll(
	post: Post,
	session: string,
	requests: readonly (readonly Turn[])[],
) {
	for (const turns of requests) {
		const body = yield* bodyOf(turns);
		const response = yield* post({ body, session });

		yield* response.text;
	}
});

const handlesIn = (body: string): readonly string[] =>
	pipe(
		Array.fromIterable(Str.matchAll(/\[sealed (?<handle>h\d+)\]/gu)(body)),
		Array.map(([, handle]) => handle ?? ""),
	);

const stableHandles = Effect.gen(function* stableHandles() {
	const { mocks, post, state } = yield* routed({ holdsPhi: holdsCanary });

	yield* postAll(post, "handles-1", conversation);
	yield* postAll(post, "handles-2", [[secondAsk]]);

	const opened = yield* mocks.open.received;
	const sealed = yield* mocks.baa.received;
	const lines = yield* laneLines(state);
	const stub = yield* jsonText(sealedStub("claude")(h2));

	assert.deepStrictEqual<unknown>(
		{
			baa: sealed.length,
			canaryOpened: pipe(
				opened,
				Array.some(({ body }) => holdsCanary(body)),
			),
			handles: pipe(
				opened,
				Array.map(({ body }) => handlesIn(body)),
			),
			reasons: pipe(
				lines,
				Array.map(({ lane, reason }) => [lane, reason]),
			),
			stubbed: pipe(
				opened,
				Array.get(secondRequest),
				Array.fromOption,
				Array.some(({ body }) => Str.includes(stub)(body)),
			),
		},
		{
			baa: 0,
			canaryOpened: false,
			handles: [["h1"], ["h1", "h2"], ["h1", "h2", "h1"], ["h1"]],
			reasons: Array.replicate(["clean", "clean"], requestsPosted),
			stubbed: true,
		},
	);
});

const privateStore = Effect.gen(function* privateStore() {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const { post, state } = yield* routed({ holdsPhi: holdsCanary });

	yield* postAll(post, "handles-3", [[firstAsk]]);

	const folder = path.join(state, "sessions");
	const file = path.join(folder, `${Base64Url.encode("handles-3")}.sealed.json`);
	const folderInfo = yield* fs.stat(folder);
	const fileInfo = yield* fs.stat(file);
	const text = yield* fs.readFileString(file);

	assert.deepStrictEqual(
		{
			file: fileInfo.mode % permissionBits,
			folder: folderInfo.mode % permissionBits,
			holdsPart: Str.includes(canaries.first)(text),
		},
		{ file: 0o600, folder: 0o700, holdsPart: true },
	);
});

const pinnedTo = Str.replace('"model":"phi/auto"', `"model":"${pinnedModel}"`);

const opensOnSealedLane = Effect.gen(function* opensOnSealedLane() {
	const { mocks, post, state } = yield* routed({ holdsPhi: holdsCanary });
	const session = "handles-4";

	yield* postAll(post, session, [[firstAsk]]);

	const pinned = yield* bodyOf([{ role: "user", text: "Redact h1 and return the claim ids." }]);
	const asked = yield* post({ body: pinnedTo(pinned), session });

	yield* asked.text;
	yield* postAll(post, session, [[{ role: "user", text: "What does h1 hold?" }]]);

	const opened = yield* mocks.open.received;
	const sealed = yield* mocks.baa.received;
	const lines = yield* laneLines(state);

	const toBaa = pipe(
		sealed,
		Array.map(({ body }) => body),
	);

	assert.deepStrictEqual(
		{
			baaOpened: pipe(
				toBaa,
				Array.map((body) => [
					Str.includes(`[content of h1]\\n${firstAsk.text}\\n[end of h1]`)(body),
					Str.includes("phi-router: you are the pinned subagent.")(body),
				]),
			),
			canaryOpened: pipe(
				opened,
				Array.some(({ body }) => holdsCanary(body)),
			),
			handleKept: pipe(
				opened,
				Array.some(({ body }) => Str.includes("What does h1 hold?")(body)),
			),
			reasons: pipe(
				lines,
				Array.map(({ lane, reason }) => [lane, reason]),
			),
		},
		{
			baaOpened: [[true, true]],
			canaryOpened: false,
			handleKept: true,
			reasons: [
				["clean", "clean"],
				["sealed", "pinned"],
				["clean", "clean"],
			],
		},
	);
});

it.layer(NodeServices.layer)("handles", (test) => {
	test.effect(
		"a sealed part reaches the open account as a stub that carries the session's sequence number of the part, the same part keeps it on every request, another part gets the next, and another session starts again at h1",
		() => stableHandles,
	);
	test.effect(
		"a pinned request gets the content behind a handle it names and the pinned instructions, and a clean request keeps the handle as written",
		() => opensOnSealedLane,
	);
	test.effect(
		"the sealed store is one 0600 file per session in the 0700 folder beside the verdict store, and holds the part's content",
		() => privateStore,
	);
});
