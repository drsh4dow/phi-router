import { Array, Effect, FileSystem, Option, String as Str, pipe } from "effect";
import { assert, it } from "@effect/vitest";
import { codexFolders, codexIn, dotenvFile, exemptionLine } from "./configured.ts";
import { folder, phiRouter } from "#tools/claude/configured.ts";
import { NodeServices } from "@effect/platform-node";

const patient = { timeout: 30_000 };

const ok = 0;

const sharedFile = 0o644;

const permissions = 0o1000;

const user = "OPENAI_API_KEY=sk-user-dotenv-secret\nNO_PROXY=corp.example\n";

const userOn = `${user}${exemptionLine}\n`;

const kept = Effect.gen(function* kept() {
	const fs = yield* FileSystem.FileSystem;
	const { dir, env } = yield* codexFolders;
	const bytes = fs.readFileString(dotenvFile(dir));

	yield* fs.writeFileString(dotenvFile(dir), user);

	const [on, once] = yield* Effect.all([phiRouter(codexIn(dir).on, env), bytes], { concurrency: 1 });
	const twice = yield* phiRouter(codexIn(dir).on, env).pipe(Effect.andThen(bytes));
	const off = yield* phiRouter(codexIn(dir).off, env);
	const after = yield* bytes;

	assert.deepStrictEqual(
		{ after, leaked: Str.includes("sk-user-dotenv-secret")(`${on.printed}${off.printed}`), once, twice },
		{ after: user, leaked: false, once: userOn, twice: userOn },
	);
}).pipe(Effect.scoped);

const made = Effect.gen(function* made() {
	const fs = yield* FileSystem.FileSystem;
	const { dir, env } = yield* codexFolders;
	const on = yield* phiRouter(codexIn(dir).on, env);
	const written = yield* fs.readFileString(dotenvFile(dir));
	const off = yield* phiRouter(codexIn(dir).off, env);
	const left = yield* fs.exists(dotenvFile(dir));

	assert.deepStrictEqual(
		{
			left,
			named: Str.includes(`phi-router removed ${exemptionLine} from ${dotenvFile(dir)}`)(off.printed),
			written,
		},
		{ left: false, named: true, written: `${exemptionLine}\n` },
		on.printed,
	);
}).pipe(Effect.scoped);

const ownLine = `NO_PROXY="\${NO_PROXY},\${no_proxy},127.0.0.1"`;

const seeds: readonly Trip[] = [
	{ off: "NO_PROXY=corp.example\n", on: `NO_PROXY=corp.example\n${exemptionLine}\n`, seed: "NO_PROXY=corp.example" },
	{ off: `${ownLine}\n`, on: `${ownLine}\n${exemptionLine}\n`, seed: `${ownLine}\n` },
	{ off: "\uFEFFA=1\n", on: `\uFEFFA=1\n${exemptionLine}\n`, seed: "\uFEFFA=1\n" },
	{
		off: "NO_PROXY=corp.example\n",
		on: `NO_PROXY=corp.example\n${exemptionLine}\n`,
		seed: `${exemptionLine}\nNO_PROXY=corp.example\n`,
	},
	{ off: "A=1\r\n", on: `A=1\r\n${exemptionLine}\n`, seed: `A=1\r\n${exemptionLine}\r\n` },
];

interface Trip {
	readonly off: string;
	readonly on: string;
	readonly seed: string;
}

/** Reads text as UTF-8 and keeps a byte order mark, so the test sees every byte phi-router left. */
const utf8 = new TextDecoder("utf-8", { ignoreBOM: true });

const roundTrip = Effect.fnUntraced(function* roundTrip({ seed }: Trip) {
	const fs = yield* FileSystem.FileSystem;
	const { dir, env } = yield* codexFolders;
	const bytes = Effect.map(fs.readFile(dotenvFile(dir)), (read) => utf8.decode(read));

	yield* fs.writeFileString(dotenvFile(dir), seed);

	const on = yield* phiRouter(codexIn(dir).on, env).pipe(Effect.andThen(bytes));
	const off = yield* phiRouter(codexIn(dir).off, env).pipe(Effect.andThen(bytes));

	return { off, on, seed };
}, Effect.scoped);

const roundTrips = Effect.gen(function* roundTrips() {
	const trips = yield* Effect.forEach(seeds, roundTrip, { concurrency: "unbounded" });

	assert.deepStrictEqual(trips, seeds);
});

const appended = "OPENAI_ORG=acme";

const own = "A=1\n# hosts my proxy skips\nNO_PROXY=corp.example # corp\nB=2";

/** A `.env` that ends with a newline, one that ends without one, or none at all, and the bytes `off` must leave. */
interface Appended {
	readonly off: string;
	readonly seed?: string;
}

const appendSeeds: readonly Appended[] = [
	{ off: `${own}\n${appended}\n`, seed: `${own}\n` },
	{ off: `${own}\n${appended}\n`, seed: own },
	{ off: `${appended}\n` },
];

const appendAfterOn = Effect.fnUntraced(function* appendAfterOn({ seed }: Appended) {
	const fs = yield* FileSystem.FileSystem;
	const { dir, env } = yield* codexFolders;
	const file = dotenvFile(dir);
	const bytes = fs.readFileString(file);

	yield* Option.match(Option.fromUndefinedOr(seed), {
		onNone: () => Effect.void,
		onSome: (text) => fs.writeFileString(file, text),
	});

	const before = yield* phiRouter(codexIn(dir).on, env).pipe(
		Effect.andThen(fs.writeFileString(file, `${appended}\n`, { flag: "a" })),
		Effect.andThen(bytes),
	);

	const off = yield* phiRouter(codexIn(dir).off, env).pipe(Effect.andThen(bytes));

	return { off, ownLine: Array.contains(Str.split("\n")(before), appended) };
}, Effect.scoped);

const appends = Effect.gen(function* appends() {
	const trips = yield* Effect.forEach(appendSeeds, appendAfterOn, { concurrency: "unbounded" });

	assert.deepStrictEqual(
		trips,
		pipe(
			appendSeeds,
			Array.map(({ off }) => ({ off, ownLine: true })),
		),
	);
});

/** `é` in Latin-1, a byte no UTF-8 text holds alone. */
const latinSmallEAcute = 233;

const ascii = new TextEncoder();

const latin1 = Uint8Array.of(...ascii.encode("P=caf"), latinSmallEAcute, ...ascii.encode("\n"));

const notUtf8 = Effect.gen(function* notUtf8() {
	const fs = yield* FileSystem.FileSystem;
	const { dir, env } = yield* codexFolders;

	yield* fs.writeFile(dotenvFile(dir), latin1);

	const on = yield* phiRouter(codexIn(dir).on, env);
	const after = yield* fs.readFile(dotenvFile(dir));

	assert.deepStrictEqual(
		{ after, failed: on.exitCode !== ok, named: Str.includes(`cannot read ${dotenvFile(dir)} as UTF-8`)(on.printed) },
		{ after: latin1, failed: true, named: true },
	);
}).pipe(Effect.scoped);

const linked = Effect.gen(function* linked() {
	const fs = yield* FileSystem.FileSystem;
	const { dir, env } = yield* codexFolders;
	const managed = yield* folder("phi-codex-dotfiles-").pipe(Effect.map(dotenvFile));

	yield* fs.writeFileString(managed, user, { mode: sharedFile });
	yield* fs.symlink(managed, dotenvFile(dir));
	yield* phiRouter(codexIn(dir).on, env);

	const link = yield* fs.readLink(dotenvFile(dir));
	const { mode } = yield* fs.stat(managed);
	const written = yield* fs.readFileString(managed);

	assert.deepStrictEqual(
		{ link, mode: mode % permissions, written },
		{ link: managed, mode: sharedFile, written: userOn },
	);
}).pipe(Effect.scoped);

it.layer(NodeServices.layer)("the exemption line in .env", (test) => {
	test.effect(
		"on adds the line after the developer's own lines, a second on leaves the same bytes, and off gives the file back byte for byte",
		() => kept,
		patient,
	);
	test.effect("off removes the .env that on made", () => made, patient);
	test.effect(
		"off gives back a .env with a byte order mark and one with the developer's own copy of the line byte for byte, one without its last newline with a newline added, and on moves its line below a later NO_PROXY and takes it back from a CRLF file",
		() => roundTrips,
		patient,
	);
	test.effect(
		"a line appended after on stays its own line, and off keeps it and every line the developer wrote, whether .env ended with a newline, without one, or was not there",
		() => appends,
		patient,
	);
	test.effect("on leaves a .env that is not UTF-8 as it was and says so", () => notUtf8, patient);
	test.effect("on writes through a symlinked .env and keeps its 0644 mode", () => linked, patient);
});
