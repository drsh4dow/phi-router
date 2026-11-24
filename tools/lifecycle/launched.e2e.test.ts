import { Array, Effect, Exit, Layer, Option, Scope, pipe } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { assert, it } from "@effect/vitest";
import { badPorts, portBelow, world } from "./launched.ts";
import { NodeServices } from "@effect/platform-node";

/** Every port `freePort` can hold: Linux hands out port 0 from 32768 up, and macOS from 49152 up to the last port. */
const holdable = { first: 32_768, last: 65_535 };

/** A held port whose port below Fetch refuses (6665), and its neighbour, whose port below it takes. */
const seen = { refused: 36_665, taken: { handedOut: 6664, held: 36_664 } };

it.layer(Layer.empty)("freePort", (test) => {
	test.effect("hands out no port that Fetch refuses, whichever port it holds", () =>
		Effect.sync(() => {
			const refused = pipe(
				Array.range(holdable.first, holdable.last),
				Array.map(portBelow),
				Array.getSomes,
				Array.filter((port) => badPorts.has(String(port))),
			);

			assert.deepStrictEqual(refused, []);
			assert.deepStrictEqual(
				[portBelow(seen.refused), portBelow(seen.taken.held)],
				[Option.none(), Option.some(seen.taken.handedOut)],
			);
		}),
	);
});

/**
 * A process whose command line is a router's on `port` from another test's bundle, as a router in another network
 * namespace can be, since a port is free in each namespace on its own.
 */
const otherTestsRouter = Effect.fnUntraced(function* otherTestsRouter(port: number) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const serving = ["/tmp/another-bundle/phi-router.js", "serve", "--port", String(port)];

	return yield* spawner.spawn(ChildProcess.make("node", ["-e", "setTimeout(() => {}, 60_000)", ...serving]));
});

it.layer(NodeServices.layer)("world", (test) => {
	test.effect("lists and kills only its own routers, though another test's router serves its port", () =>
		Effect.gen(function* ownRoutersOnly() {
			const scope = yield* Scope.make();
			const here = yield* Scope.provide(world("/tmp/this-bundle/phi-router.js"), scope);
			const other = yield* otherTestsRouter(here.port);
			const listed = yield* here.routers;

			yield* Scope.close(scope, Exit.void);

			assert.deepStrictEqual({ listed, otherRuns: yield* other.isRunning }, { listed: [], otherRuns: true });
		}).pipe(Effect.scoped),
	);
});
