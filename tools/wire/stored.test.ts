import { Array, Effect, FileSystem, Order, Path, Struct } from "effect";
import { assert, describe, it } from "@effect/vitest";
import { laneLogHolds, storedIn } from "./stored.ts";
import { Digest } from "effect/crypto";
import type { LaneLogLine } from "#tools/route/mocked-router.ts";
import { NodeServices } from "@effect/platform-node";
import type { Sent } from "#router/client/mock-upstreams/index.ts";
import type { Stored } from "./stored.ts";
import { contentKey } from "#router/primitives/content-key.ts";

const modes = { open: 0o644, private: 0o600, privateFolder: 0o700, shared: 0o755 } as const;

const line: LaneLogLine = {
	account: "open",
	judgeCost: 0,
	judgeFailures: 0,
	lane: "clean",
	model: "target-under-test",
	reason: "clean",
	session: "s1",
	substitute: false,
	time: "2026-01-01T00:00:00.000Z",
};

const laneLogText = `{"account":"open","judgeCost":0,"judgeFailures":0,"lane":"clean","model":"target-under-test","reason":"clean","session":"s1","substitute":false,"time":"2026-01-01T00:00:00.000Z"}\n`;

const sent = (method: string, path: string): Sent => ({ body: "{}", headers: {}, method, path, query: "" });

const stored = (lines: readonly LaneLogLine[], text: string): Stored => ({
	fileTexts: [text],
	laneLogText: text,
	lines,
	notPrivate: [],
});

const turns = [
	{ baa: [], open: [sent("GET", "/v1/models"), sent("POST", "/v1/messages")] },
	{ baa: [sent("POST", "/v1/responses")], open: [] },
];

const stateFolder = Effect.gen(function* stateFolder() {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const root = yield* fs.makeTempDirectoryScoped({ prefix: "phi-wire-stored-" });
	const state = path.join(root, "phi-router");
	const sessions = path.join(state, "sessions");
	const shared = path.join(root, "shared");

	yield* fs.makeDirectory(sessions, { recursive: true });
	yield* fs.makeDirectory(shared);
	yield* fs.writeFileString(path.join(state, "lanes.jsonl"), laneLogText);
	yield* fs.writeFileString(path.join(sessions, "czE.json"), "a session's verdicts");
	yield* fs.writeFileString(path.join(shared, "open.txt"), "left open");
	yield* fs.chmod(state, modes.privateFolder);
	yield* fs.chmod(sessions, modes.privateFolder);
	yield* fs.chmod(path.join(state, "lanes.jsonl"), modes.private);
	yield* fs.chmod(path.join(sessions, "czE.json"), modes.private);
	yield* fs.chmod(shared, modes.shared);
	yield* fs.chmod(path.join(shared, "open.txt"), modes.open);

	return { root, shared, state };
});

const readBack = Effect.gen(function* readBack() {
	const path = yield* Path.Path;
	const { root, shared, state } = yield* stateFolder;
	const left = yield* storedIn(state, [root]);

	assert.deepStrictEqual(
		Struct.assign(left, {
			fileTexts: Array.sort(left.fileTexts, Order.String),
			notPrivate: Array.sort(left.notPrivate, Order.String),
		}),
		{
			fileTexts: ["", "a session's verdicts", laneLogText],
			laneLogText,
			lines: [line],
			notPrivate: [`${shared} 755`, `${path.join(shared, "open.txt")} 644`],
		},
	);
}).pipe(Effect.scoped);

const laneLogChecked = Effect.gen(function* laneLogChecked() {
	const key = yield* contentKey(["user", "Member p-17 called."]);

	assert.deepStrictEqual(
		[
			laneLogHolds({ stored: stored([line, line], laneLogText), turns }),
			laneLogHolds({ stored: stored([line], laneLogText), turns }),
			laneLogHolds({ stored: stored([line, line], `${laneLogText}${key}\n`), turns }),
		],
		[true, false, false],
	);
});

describe("what a wire run left in the router's state folder", () => {
	it.layer(NodeServices.layer)((test) => {
		test.effect(
			"holds the text of every file under it, nested ones too, the lane log's lines, and each file and folder under the roots that is not 0600 or 0700",
			() => readBack,
		);
	});
	it.layer(Digest.layerWebCrypto)((test) => {
		test.effect(
			"holds a lane log with one line per model request an account received, and no content key",
			() => laneLogChecked,
		);
	});
});
