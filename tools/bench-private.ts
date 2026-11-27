import { Effect } from "effect";
import { NodeServices } from "@effect/platform-node";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import * as cached from "../src/router/client/private-file.ts";
import * as uncached from "../src/router/client/private-file-original.ts";

const n = 25;
const windows = process.platform === "win32";
const system32 = join(process.env["SystemRoot"] ?? "C:\\Windows", "System32");

const summary = (xs: number[]): string => {
	const sorted = [...xs].sort((a, b) => a - b);
	const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!.toFixed(1);
	return `median ${at(0.5)} ms, p10 ${at(0.1)}, p90 ${at(0.9)}, min ${sorted[0]!.toFixed(1)}, max ${sorted.at(-1)!.toFixed(1)} (n=${n})`;
};

const time = async (label: string, once: () => Promise<unknown>) => {
	await once();
	const xs: number[] = [];
	for (let i = 0; i < n; i++) {
		const t = performance.now();
		await once();
		xs.push(performance.now() - t);
	}
	console.log(`BENCH ${label}: ${summary(xs)}`);
};

const run = (e: Effect.Effect<unknown, unknown, any>) =>
	Effect.runPromise(Effect.provide(e, NodeServices.layer) as Effect.Effect<unknown, unknown>);

const root = mkdtempSync(join(tmpdir(), "bench-private-"));
console.log(`BENCH platform ${process.platform}, root ${root}`);

await time("runtime overhead (Effect.void)", () => run(Effect.void));

if (windows) {
	await time("spawn whoami /user", async () =>
		spawnSync(join(system32, "whoami.exe"), ["/user", "/fo", "csv", "/nh"]),
	);
	await time("spawn icacls /save", async () =>
		spawnSync(join(system32, "icacls.exe"), [root, "/save", join(root, "acl.txt")]),
	);
}

for (const [name, m] of [
	["final", cached],
	["fb8a9199", uncached],
] as const) {
	const state = join(root, name, "state", "phi-router");
	await time(`${name} writePrivately, router state folder`, () =>
		run(m.writePrivately(join(state, "leases.json"), "{}")),
	);
	await time(`${name} appendPrivately, router state folder`, () =>
		run(m.appendPrivately(join(state, "lanes.jsonl"), "line\n")),
	);

	if (windows) {
		const shared = join(root, name, "shared");
		mkdirSync(shared, { recursive: true });
		spawnSync(join(system32, "icacls.exe"), [shared, "/grant", "*S-1-1-0:(OI)(CI)(R)"]);
		await time(`${name} writePrivately, shared folder`, () =>
			run(m.writePrivately(join(shared, "settings.json"), "{}")),
		);
		await time(`${name} appendPrivately, shared folder`, () =>
			run(m.appendPrivately(join(shared, "log.jsonl"), "line\n")),
		);
	}
}
