import { Array, Effect, Exit, Option, Schema, Scope, pipe } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { FetchHttpClient, HttpClient } from "effect/http";
import { assert, it } from "@effect/vitest";
import { badPorts, instance, portBelow, ran, world } from "./launched.ts";
import { NodeServices } from "@effect/platform-node";
import { TestClock } from "effect/testing";

const portZero = { linux: { first: 32_768, last: 60_999 }, macosLast: 65_535 };

const heldBesideBadPort6665 = { refused: 36_665, taken: { handedOut: 6664, held: 36_664 } };

const BadPort = Schema.Struct({ message: Schema.Literal("bad port") });

const BadPortRefusal = Schema.Struct({ cause: Schema.Struct({ cause: BadPort }) });

const takenByFetch = Effect.fnUntraced(function* takenByFetch(port: string) {
	const client = yield* HttpClient.HttpClient;

	return yield* client.head(`http://127.0.0.1:${port}/`).pipe(
		Effect.as(true),
		Effect.catchReason("HttpClientError", "TransportError", (reason) =>
			Effect.succeed(!Schema.is(BadPortRefusal)(reason)),
		),
	);
});

it.layer(FetchHttpClient.layer)("freePort", (test) => {
	test.effect("hands out no port that Fetch refuses, whichever port it holds", () =>
		Effect.sync(() => {
			const refused = pipe(
				Array.range(portZero.linux.first, portZero.macosLast),
				Array.map(portBelow),
				Array.getSomes,
				Array.filter((port) => badPorts.has(String(port))),
			);

			assert.deepStrictEqual(refused, []);
			assert.deepStrictEqual(
				[portBelow(heldBesideBadPort6665.refused), portBelow(heldBesideBadPort6665.taken.held)],
				[Option.none(), Option.some(heldBesideBadPort6665.taken.handedOut)],
			);
		}),
	);

	test.effect("hands out a port below Linux's port-0 range, whichever port of that range it holds", () =>
		Effect.sync(() => {
			const inRange = pipe(
				Array.range(portZero.linux.first, portZero.linux.last),
				Array.map(portBelow),
				Array.getSomes,
				Array.filter((port) => port >= portZero.linux.first),
			);

			assert.deepStrictEqual(inRange, []);
		}),
	);

	test.effect("holds back only ports Fetch refuses", () =>
		Effect.gen(function* heldBack() {
			const taken = yield* Effect.filter(Array.fromIterable(badPorts), takenByFetch, { concurrency: "unbounded" });

			assert.deepStrictEqual(taken, []);
		}),
	);
});

const thisBundle = "/tmp/this-bundle/phi-router.js";

const anotherBundle = "/tmp/another-bundle/phi-router.js";

const routerOf = Effect.fnUntraced(function* routerOf(entry: string, port: number) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const serving = [entry, "serve", "--port", String(port)];

	return yield* spawner.spawn(ChildProcess.make("node", ["-e", "setTimeout(() => {}, 60_000)", ...serving]));
});

const stillRuns = 0;

it.layer(NodeServices.layer)("world", (test) => {
	test.effect("lists and kills its own routers only, though another test's router serves its port", () =>
		Effect.gen(function* ownRoutersOnly() {
			const scope = yield* Scope.make();
			const here = yield* Scope.provide(world(thisBundle), scope);
			const own = yield* routerOf(thisBundle, here.port);
			const other = yield* routerOf(anotherBundle, here.port);
			const listed = yield* here.routers;

			yield* Scope.close(scope, Exit.void);

			const ownEnded = yield* own.exitCode.pipe(
				Effect.exit,
				Effect.timeoutOption("5 seconds"),
				Effect.map(Option.isSome),
				TestClock.withLive,
			);

			assert.deepStrictEqual(
				{ listed, otherRuns: yield* other.isRunning, ownEnded },
				{ listed: [Number(own.pid)], otherRuns: true, ownEnded: true },
			);
		}).pipe(Effect.scoped),
	);

	test.effect("an instance ends once its scope closes", () =>
		Effect.gen(function* ended() {
			const scope = yield* Scope.make();
			const { pid } = yield* Scope.provide(instance(), scope);

			yield* Scope.close(scope, Exit.void);

			const signalled = yield* ran(["kill", "-0", String(pid)], {});

			assert.notStrictEqual(signalled.exitCode, stillRuns);
		}),
	);
});
