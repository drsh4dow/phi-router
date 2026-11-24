import { Array, Effect, FileSystem, Layer, String as Str, Struct } from "effect";
import { assert, it } from "@effect/vitest";
import { bundled, instance, ran, routersOn, world } from "./launched.ts";
import { flooder, secretKept, squatter } from "./squatter.ts";
import { hmacOf, proofOf } from "#router/client/router-port/index.ts";
import { Digest } from "effect/crypto";
import { FetchHttpClient } from "effect/http";
import { NodeServices } from "@effect/platform-node";
import { mocked } from "#tools/route/mocked-router.ts";
import { writePrivately } from "#router/client/private-file.ts";

const patient = { timeout: 60_000 };

const refusal = "the port does not hold your router";

const ok = 0;

const permissionBits = 0o1000;

const anotherSecret = "7777777777777777777777777777777777777777777777777777777777777777";

const vector = {
	nonce: "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
	port: 47_411,
	proof: "8779f5a49e5c9dfe87939d7048463039446fd8cdb0814abbb02f7e927c3411df",
	secret: "abababababababababababababababababababababababababababababababab",
};

const hmac = Effect.gen(function* hmac() {
	const proof = yield* proofOf(vector.secret, vector.nonce, vector.port);

	assert.strictEqual(proof, vector.proof);
});

const encoder = new TextEncoder();

const bytesOf = (text: string): readonly number[] => Array.fromIterable(encoder.encode(text));

const caseOneByte = 11;

const caseOneLength = 20;

const caseSixByte = 170;

const caseSixLength = 131;

/** One RFC 4231 test case: its number, its data and key, and the HMAC-SHA-256 it gives. */
interface RfcCase {
	readonly case: number;
	readonly data: string;
	readonly key: readonly number[];
	readonly mac: string;
}

/** RFC 4231 section 4: test cases 1 and 2, and 6, whose 131-byte key is longer than a block. */
const rfc4231 = [
	{
		case: 1,
		data: "Hi There",
		key: Array.replicate(caseOneByte, caseOneLength),
		mac: "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7",
	},
	{
		case: 2,
		data: "what do ya want for nothing?",
		key: bytesOf("Jefe"),
		mac: "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
	},
	{
		case: 6,
		data: "Test Using Larger Than Block-Size Key - Hash Key First",
		key: Array.replicate(caseSixByte, caseSixLength),
		mac: "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54",
	},
] satisfies readonly RfcCase[];

const rfcCase = Effect.fnUntraced(function* rfcCase(test: RfcCase) {
	const mac = yield* hmacOf(test.key, bytesOf(test.data));

	assert.strictEqual(mac, test.mac);
});

/**
 * `phi-router start` from a fresh bundle for a live pid against the listener on `port`, with the developer's secret in
 * place: what it printed, and the routers it launched that still run.
 */
const startedAgainst = Effect.fnUntraced(function* startedAgainst(port: number) {
	const entry = yield* bundled();
	const { env, state } = yield* mocked({ holdsPhi: () => false });
	const holder = yield* instance();

	yield* secretKept(state);

	const lease = ["--pid", String(holder.pid), "--session", "s1", "--folder", "/work", "--port", String(port)];

	const started = yield* ran(["node", entry, "start", ...lease], env);
	const routers = yield* routersOn(entry, port);

	return Struct.assign(started, { routers });
});

const squatted = Effect.fnUntraced(function* squatted() {
	const other = yield* squatter;
	const started = yield* startedAgainst(other.port);
	const received = yield* other.received;

	assert.deepStrictEqual(
		{
			failed: started.exitCode !== ok,
			received,
			refused: Str.includes(refusal)(started.printed),
			routers: started.routers,
		},
		{ failed: true, received: ["GET /phi-router/proof"], refused: true, routers: [] },
		"the listener got the nonce request alone, start failed naming the port, and no router was launched",
	);
}, Effect.scoped);

const flooded = Effect.fnUntraced(function* flooded() {
	const port = yield* flooder;
	const started = yield* startedAgainst(port);

	assert.isTrue(Str.includes(refusal)(started.printed), "start reads a bounded answer and refuses the listener");
}, Effect.scoped);

/** How a test takes the developer's secret away from under their running router. */
const losses = {
	removed: (fs: FileSystem.FileSystem, file: string) => fs.remove(file),
	unreadable: (fs: FileSystem.FileSystem, file: string) =>
		fs.remove(file).pipe(Effect.andThen(fs.makeDirectory(file))),
} as const;

/** The router's own listener, which proves itself, and the modes of its secret and of the folder holding it. */
const ownRouter = Effect.fnUntraced(function* ownRouter() {
	const fs = yield* FileSystem.FileSystem;
	const here = yield* bundled().pipe(Effect.flatMap(world));
	const first = yield* instance();
	const started = yield* here.start(first.pid);
	const secret = `${here.state}/secret`;
	const file = yield* fs.stat(secret);
	const folder = yield* fs.stat(here.state);
	const value = yield* fs.readFileString(secret);

	return {
		here,
		modes: { file: file.mode % permissionBits, folder: folder.mode % permissionBits, started: started.exitCode },
		printed: started.printed,
		secret,
		value,
	};
});

const lost = Effect.fnUntraced(function* lost(loss: keyof typeof losses) {
	const fs = yield* FileSystem.FileSystem;
	const { here, modes, printed, secret, value } = yield* ownRouter();
	const second = yield* instance();

	assert.deepStrictEqual(
		modes,
		{ file: 0o600, folder: 0o700, started: ok },
		"the router proves itself, under a secret kept 0600 in a 0700 folder",
	);

	yield* losses[loss](fs, secret);

	const refused = yield* here.start(second.pid);

	assert.deepStrictEqual(
		{
			failed: refused.exitCode !== ok,
			leaked: Str.includes(value)(`${printed}${refused.printed}`),
			refused: Str.includes(refusal)(refused.printed),
		},
		{ failed: true, leaked: false, refused: true },
		"start fails naming the port, and never prints the secret",
	);
}, Effect.scoped);

/** A second router of the developer, on another port, wrote a fresh secret while the first one runs. */
const rewritten = Effect.fnUntraced(function* rewritten() {
	const { here, secret } = yield* ownRouter();
	const second = yield* instance();

	yield* writePrivately(secret, anotherSecret);

	const again = yield* here.start(second.pid);

	assert.strictEqual(again.exitCode, ok, "the running router answers under the secret now in the file");
}, Effect.scoped);

it.layer(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer, Digest.layerWebCrypto))(
	"the port's proof",
	(test) => {
		test.effect("is HMAC-SHA-256 of the nonce and the port under the secret's 64 hex digits", () => hmac);
		test.effect.each(rfc4231)("computes HMAC-SHA-256 as RFC 4231 test case $case gives it", rfcCase);
		test.effect(
			"start refuses another user's listener that answers under its own secret, having sent it the nonce alone",
			() => squatted(),
			patient,
		);
		test.effect("start refuses a listener whose answer never ends", () => flooded(), patient);
		test.effect(
			"start still proves the developer's router once another of their routers wrote a fresh secret",
			() => rewritten(),
			patient,
		);
		test.effect.each(["removed", "unreadable"] as const)(
			"start fails closed once the developer's secret is %s, though their router still runs",
			lost,
			patient,
		);
	},
);
