import { Console, Effect, FileSystem } from "effect";
import { NodeRuntime, NodeServices } from "@effect/platform-node";

import { mocked } from "../../../../tools/route/mocked-router.ts";
import { routerProcess } from "../../../../tools/route/router-process.ts";

const [harness = "claude", port = "0"] = process.argv.slice(2);
const canary = process.env.CANARY ?? "PHI-RECIPE-CANARY-29";
const holding = (sent: readonly unknown[]): boolean => JSON.stringify(sent).includes(canary);
const baaStatus = Number(process.env.BAA_STATUS ?? "200");
const refusing = { body: '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}' };
const baa = baaStatus === 200 ? {} : { baa: () => ({ ...refusing, kind: "status" as const, status: baaStatus }) };

const routerCommand =
	port === "0"
		? ["bun", "src/router/main.ts"]
		: ["sh", "-c", `exec bun src/router/main.ts serve --port ${port}`, "router"];

const program = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	const { env, mocks, state } = yield* mocked({
		...baa,
		harness,
		holdsPhi: (piece: string) => piece.includes(canary),
	});

	const received = Effect.gen(function* () {
		const open = yield* mocks.open.received;
		const baa = yield* mocks.baa.received;
		const judge = yield* mocks.judge.received;
		const lanes = yield* fs.readFileString(`${state}/lanes.jsonl`).pipe(Effect.orElseSucceed(() => ""));

		return JSON.stringify({
			received: { open: open.length, baa: baa.length, judge: judge.length },
			canaryAt: { open: holding(open), baa: holding(baa) },
			lanes: lanes
				.split("\n")
				.filter(Boolean)
				.map((line) => {
					const { account, lane, reason } = JSON.parse(line);
					return `${lane}/${account}/${reason}`;
				}),
		});
	});

	yield* Effect.addFinalizer(() => Effect.flatMap(received, Console.log).pipe(Effect.orDie));

	const url = port === "none" ? "none" : (yield* routerProcess(routerCommand, env)).url;

	yield* Console.log(JSON.stringify({ url, state, env }));
	yield* Effect.never;
}).pipe(Effect.scoped);

NodeRuntime.runMain(Effect.provide(program, NodeServices.layer));
