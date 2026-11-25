import { Effect, FileSystem, Path } from "effect";
import type { Typed, World } from "./world.ts";
import {
	asDarwin,
	baaKey,
	codexSignedIn,
	down,
	endOfInput,
	enter,
	firstPick,
	holdsKeyPiece,
	judgeKey,
	keyFiles,
	keyPicked,
	keysOutsideKeyFiles,
	layer,
	maxAnswers,
	ok,
	patient,
	piHolds,
	piLogin,
	questions,
	setUp,
	withEnv,
	withStatus,
	writtenConfigOf,
} from "./set-up.ts";
import { assert, it } from "@effect/vitest";
import { keys, world } from "./world.ts";
import type { PlatformError } from "effect";

const everyoneFound = `phi-router found
  Claude Code     Claude Max · you@example.com
  Codex           ChatGPT Plus · you@example.com
  pi              Claude
  Also found      Anthropic key from ANTHROPIC_API_KEY
                  OpenAI key from OPENAI_API_KEY
                  OpenAI key saved in pi

  Everyday work   Claude Max · you@example.com   ✓
  Patient data    pick below
  PHI check       pick below
`;

const envKeys = { ANTHROPIC_API_KEY: keys.anthropic, OPENAI_API_KEY: keys.openai };

const everyone = Effect.fnUntraced(function* everyone(of: World) {
	yield* codexSignedIn(of);
	yield* piHolds(of, { anthropic: piLogin, openai: { key: keys.openai, type: "api_key" } });

	return withEnv(envKeys)(of);
});

const everythingFound = Effect.gen(function* everythingFound() {
	const of = yield* world.pipe(Effect.flatMap(everyone));

	const run = yield* setUp(of, "claude", [
		{ after: questions.baa, typed: `${down}${down}` },
		{ after: questions.openai, typed: `${down}${down}` },
		enter,
	]);

	const checked = yield* of.checkedKeys();
	const outside = yield* keysOutsideKeyFiles(of, [run.shown]);

	assert.strictEqual(run.exitCode, ok, run.shown);
	assert.include(run.shown, everyoneFound);
	assert.deepStrictEqual(firstPick({ question: questions.openai, shown: run.shown }), [
		"❯ Another OpenAI key",
		"  OpenAI key from OPENAI_API_KEY",
		"  OpenAI key saved in pi",
		"  I don't have one",
	]);
	assert.include(run.shown, "  Patient data    Anthropic key from ANTHROPIC_API_KEY\n");
	assert.deepStrictEqual(checked, [keys.anthropic, keys.openai], "setup checked the keys it found");
	assert.deepStrictEqual(outside, [], "no key and no piece of one in the output or outside its key file");
}).pipe(Effect.scoped);

type Given = (of: World) => Effect.Effect<World, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path>;

interface FoundKey {
	readonly kind: string;
	readonly given: Given;
	readonly question: string;
	readonly pick: readonly string[];
	readonly answers: readonly Typed[];
}

const savedEarlier: Given = Effect.fnUntraced(function* savedEarlier(of: World) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const { anthropic } = keyFiles(of);

	yield* fs.makeDirectory(path.dirname(anthropic), { mode: 0o700, recursive: true });
	yield* fs.writeFileString(anthropic, `${keys.anthropic}\n`, { mode: 0o600 });

	return of;
});

const anthropicPick = ["❯ Anthropic API key", "  Claude Enterprise login"];

const thirdAnthropicChoice = [{ after: questions.baa, typed: `${down}${down}` }, judgeKey, enter];

const foundKeys: readonly FoundKey[] = [
	{
		answers: thirdAnthropicChoice,
		given: (of) => Effect.succeed(withEnv({ ANTHROPIC_API_KEY: keys.anthropic })(of)),
		kind: "a key in ANTHROPIC_API_KEY",
		pick: [...anthropicPick, "  Anthropic key from ANTHROPIC_API_KEY"],
		question: questions.baa,
	},
	{
		answers: [keyPicked, { after: questions.openai, typed: down }, baaKey, enter],
		given: (of) => Effect.succeed(withEnv({ OPENAI_API_KEY: keys.openai })(of)),
		kind: "a key in OPENAI_API_KEY",
		pick: ["❯ Another OpenAI key", "  OpenAI key from OPENAI_API_KEY", "  I don't have one"],
		question: questions.openai,
	},
	{
		answers: thirdAnthropicChoice,
		given: savedEarlier,
		kind: "a key file an earlier setup saved",
		pick: [...anthropicPick, "  Anthropic key from your last setup"],
		question: questions.baa,
	},
];

const offered = Effect.fnUntraced(function* offered({ answers, given, pick, question }: FoundKey) {
	const of = yield* world.pipe(Effect.flatMap(given));
	const run = yield* setUp(of, "claude", answers);
	const checked = yield* of.checkedKeys();

	assert.strictEqual(run.exitCode, ok, run.shown);
	assert.deepStrictEqual(firstPick({ question, shown: run.shown }), pick, run.shown);
	assert.isFalse(holdsKeyPiece(run.shown), "no part of a key shows");
	assert.deepStrictEqual(checked, [keys.anthropic, keys.openai], "setup checked the key picked and the key typed");
}, Effect.scoped);

const macNote =
	"Claude Enterprise sign-in isn't available on macOS yet: Claude Code keeps sign-ins in the Keychain, and phi-router reads only a file.";

const macFound = `  Everyday work   Claude Max · you@example.com   ✓
  Patient data    pick below
  PHI check       needs an OpenAI key
${macNote}
`;

const onMac = Effect.gen(function* onMac() {
	const base = yield* world;
	const of = withEnv({ ANTHROPIC_API_KEY: keys.anthropic })(base);

	yield* asDarwin(of);

	const run = yield* setUp(of, "claude", [{ after: questions.baa, typed: endOfInput }]);

	assert.include(run.shown, macFound);
	assert.deepStrictEqual(firstPick({ question: questions.baa, shown: run.shown }), [
		"❯ Anthropic API key",
		"  Anthropic key from ANTHROPIC_API_KEY",
	]);
	assert.notInclude(run.shown, "Claude Enterprise login");
}).pipe(Effect.scoped);

const tokenStatus = '{"loggedIn":true,"authMethod":"oauth_token","apiProvider":"firstParty","subscriptionType":null}';

const tokenSubscriber = Effect.gen(function* tokenSubscriber() {
	const of = yield* world;

	yield* withStatus(of, tokenStatus);

	const run = yield* setUp(of, "claude", maxAnswers);
	const config = yield* writtenConfigOf(of);

	assert.strictEqual(run.exitCode, ok, run.shown);
	assert.include(run.shown, "  Claude Code     Claude subscription\n");
	assert.include(run.shown, "  Everyday work   Claude subscription\n  Patient data    Anthropic API key\n");
	assert.deepNestedInclude(config, { "clean[0].forwarded": true });
}).pipe(Effect.scoped);

it.layer(layer)("setup finds what the machine has", (test) => {
	test.effect(
		"a Claude subscription signed in through CLAUDE_CODE_OAUTH_TOKEN is the everyday account Claude Code forwards",
		() => tokenSubscriber,
		patient,
	);
	test.effect(
		"the first screen names each signed-in harness with its plan and account and each key found, and no key or piece of one shows anywhere",
		() => everythingFound,
		patient,
	);
	test.effect.each(foundKeys)(
		"setup offers $kind by where it is, shows none of it, and starts the cursor on the key to type",
		offered,
		patient,
	);
	test.effect("on macOS setup never offers a Claude Enterprise login and says why", () => onMac, patient);
});
