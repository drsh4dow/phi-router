import { Array, Effect, FileSystem, Layer, Option, Path, Record, String as Str, Struct } from "effect";
import { answers, bundled, instance, leasedPids, ran, refusedWithin, world } from "./launched.ts";
import { assert, it } from "@effect/vitest";
import { FetchHttpClient } from "effect/http";
import { NodeServices } from "@effect/platform-node";
import { TestClock } from "effect/testing";

const patient = { timeout: 60_000 };
const leaseIntervalAndAHalf = "7 seconds";
const tenSeconds = 10_000;
const succeeded = 0;

type Script = Option.Option<string>;

const standIns = {
	"answers after 3 s": (realPs: string): Script => Option.some(`#!/bin/sh\nsleep 3\nexec ${realPs} "$@"\n`),
	"exits 0 with a malformed own row": (): Script => Option.some('#!/bin/sh\necho "$$ S not-a-date"\necho garbage\n'),
	"exits 0 with an own row at an impossible time": (): Script =>
		Option.some('#!/bin/sh\necho "$$ S    Sat Nov 99 99:99:99 2026"\n'),
	"exits 0 with an own row that has no start time": (): Script => Option.some('#!/bin/sh\necho "$$ S not-a-date"\n'),
	"exits 0 with no output": (): Script => Option.some("#!/bin/sh\nexit 0\n"),
	"exits 0 with rows for other pids only": (realPs: string): Script =>
		Option.some(`#!/bin/sh\nexec ${realPs} -o pid=,stat=,lstart= -p 1\n`),
	"exits 1 after its own row": (realPs: string): Script =>
		Option.some(`#!/bin/sh\n${realPs} -o pid=,stat=,lstart= -p $$\nexit 1\n`),
	"exits 2 with no output": (): Script => Option.some("#!/bin/sh\nexit 2\n"),
	"is killed after its own row": (realPs: string): Script =>
		Option.some(`#!/bin/sh\n${realPs} -o pid=,stat=,lstart= -p $$\nkill -KILL $$\n`),
	"is missing": (): Script => Option.none<string>(),
	"prints a blank line, then its own row": (realPs: string): Script =>
		Option.some(`#!/bin/sh\necho\nexec ${realPs} -o pid=,stat=,lstart= -p $$\n`),
	"prints garbage": (): Script => Option.some("#!/bin/sh\necho 'PID STAT STARTED'\necho '1 S then'\necho oops\n"),
	"prints its own row, then garbage": (realPs: string): Script =>
		Option.some(`#!/bin/sh\n${realPs} -o pid=,stat=,lstart= -p $$\necho garbage\n`),
};

type Broken = keyof typeof standIns;

const runnable = 0o755;

const found = Effect.fnUntraced(function* found(name: string) {
	const { printed } = yield* ran(["sh", "-c", `command -v ${name}`], {});

	return Str.trim(printed);
});

const pathWithPs = Effect.fnUntraced(function* pathWithPs(broken: Broken) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const folder = yield* fs.makeTempDirectoryScoped({ prefix: "phi-router-path-" });
	const ps = path.join(folder, "ps");
	const [node, sleep, realPs] = yield* Effect.all([found("node"), found("sleep"), found("ps")], { concurrency: 1 });
	const removed = fs.remove(ps, { force: true });
	const heals = removed.pipe(Effect.andThen(fs.symlink(realPs, ps)));

	yield* Effect.all(
		[fs.symlink(node, path.join(folder, "node")), fs.symlink(sleep, path.join(folder, "sleep")), heals],
		{
			concurrency: 1,
		},
	);

	const breaks = Option.match(standIns[broken](realPs), {
		onNone: () => removed,
		onSome: (text) => removed.pipe(Effect.andThen(fs.writeFileString(ps, text, { mode: runnable }))),
	});

	return { breaks, folder, heals };
});

const afterACheck = Effect.fnUntraced(function* afterACheck(port: number, state: string) {
	yield* TestClock.withLive(Effect.sleep(leaseIntervalAndAHalf));

	const up = yield* answers(port);
	const leases = yield* leasedPids(state);

	return { leases, up };
});

const keptWhileUnread = Effect.fnUntraced(function* keptWhileUnread(entry: string, broken: Broken) {
	const ps = yield* pathWithPs(broken);
	const here = yield* world(entry, { PATH: ps.folder });
	const harness = yield* instance();
	yield* Effect.filterOrElse(
		here.start(harness.pid),
		({ exitCode }) => exitCode === succeeded,
		({ exitCode, printed }) => Effect.die(`start exited ${String(exitCode)}: ${printed}`),
	);

	yield* ps.breaks;

	const kept = yield* afterACheck(here.port, here.state);

	yield* ps.heals;
	yield* harness.end;

	const gone = yield* TestClock.withLive(refusedWithin(here.port, tenSeconds));

	return { gone, kept, pid: harness.pid };
}, Effect.scoped);

it.layer(Layer.merge(NodeServices.layer, FetchHttpClient.layer))("a ps that does not prove it read", (test) => {
	test.effect(
		"keeps the lease and the router up while the leased process lives, and the router goes within 10 s once ps works",
		() =>
			Effect.gen(function* unread() {
				const entry = yield* bundled();

				const broken = Record.keys(standIns);

				const runs = yield* Effect.forEach(broken, (each) => keptWhileUnread(entry, each), {
					concurrency: "unbounded",
				});

				const seen = Record.fromIterableWith(Array.zip(broken, runs), ([each, run]) => [
					each,
					Struct.assign(run.kept, { goneWithinTenSeconds: run.gone < tenSeconds }),
				]);

				const required = Record.fromIterableWith(Array.zip(broken, runs), ([each, run]) => [
					each,
					{ goneWithinTenSeconds: true, leases: [run.pid], up: true },
				]);

				assert.deepStrictEqual(seen, required);
			}).pipe(Effect.scoped),
		patient,
	);
});
