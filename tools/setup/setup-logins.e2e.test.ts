import { Array, Effect, FileSystem, String as Str, pipe } from "effect";
import type { Typed, World } from "./world.ts";
import {
	asDarwin,
	down,
	enter,
	enterpriseStatus,
	firstPick,
	judgeKey,
	keyFiles,
	lastLine,
	layer,
	loginFolders,
	noAnother,
	ok,
	ownSettings,
	patient,
	questions,
	setUp,
	tracked,
	version,
	withStatus,
	writeOwnSettings,
	writtenConfigOf,
} from "./set-up.ts";
import { assert, it } from "@effect/vitest";
import { world } from "./world.ts";

const coveredQuestion = "Does your BAA cover Claude Enterprise (dr.roe@clinic.example)?";

const covered: Typed = { after: coveredQuestion, typed: "" };

const loginCode: Typed = { after: "Paste code here", typed: "CODE-123" };

const enterpriseFound = `phi-router found
  Claude Code     Claude Enterprise · dr.roe@clinic.example

  PHI check       needs an OpenAI key
`;

const enterpriseNote = "! Check that your BAA covers Claude Code through phi-router.";

const enterpriseEnd = `✓ Signed in as Claude Max · roe@example.com
✓ Installed phi-router ${version} in Claude Code
✓ Test: a fake patient record reached Claude Max only as a handle
✓ Claude Code now sends its requests through phi-router
✓ Claude Code's status line shows this session's sealed and cleared counts while the model is phi/auto or phi/sealed

  Everyday work   Claude Max · roe@example.com
  Patient data    Claude Enterprise · dr.roe@clinic.example
  PHI check       OpenAI
`;

const once = 1;

const notedOnce = (shown: string): boolean =>
	pipe(Str.split("\n")(shown), Array.filter(Str.startsWith(enterpriseNote)), (noted) => noted.length === once);

const loginsOf = Effect.fnUntraced(function* loginsOf(of: World) {
	const fs = yield* FileSystem.FileSystem;

	return yield* fs.readFileString(`${of.fakeHarnessFolder}/logins`);
});

const enterpriseRerun = Effect.fnUntraced(function* enterpriseRerun(of: World) {
	const { after, before, run } = yield* tracked(of, ["setup", "claude"], [enter]);

	assert.strictEqual(run.exitCode, ok, run.shown);
	assert.notInclude(run.shown, "❯", "a rerun with every role filled asks no question");
	assert.notInclude(run.shown, "key (", "a rerun asks for no key");
	assert.deepStrictEqual(after, before, "a rerun changes no file");
});

const enterpriseSetUp = Effect.gen(function* enterpriseSetUp() {
	const of = yield* world;

	yield* withStatus(of, enterpriseStatus);
	yield* writeOwnSettings(of);

	const run = yield* setUp(of, "claude", [
		covered,
		{ after: questions.everyday, typed: "" },
		noAnother,
		judgeKey,
		loginCode,
		enter,
	]);

	assert.strictEqual(run.exitCode, ok, run.shown);
	assert.include(run.shown, enterpriseFound);
	assert.include(
		run.shown,
		"Add another subscription? It takes over when the subscription you sign in to hits its rate limit.",
	);
	assert.deepStrictEqual(firstPick({ question: coveredQuestion, shown: run.shown }), ["❯ Yes", "  No"]);
	assert.deepStrictEqual(firstPick({ question: questions.everyday, shown: run.shown }), [
		"❯ Claude Pro or Max",
		"  Nothing else",
	]);
	assert.isTrue(notedOnce(run.shown), run.shown);
	assert.include(run.shown, enterpriseEnd);

	const config = yield* writtenConfigOf(of);
	const logins = yield* loginsOf(of);

	assert.deepStrictEqual(config, {
		clean: [{ loginFolder: loginFolders(of).open, name: "claude-1", vendor: "anthropic" }],
		judge: { endpoint: "https://api.openai.com/v1", keyFile: keyFiles(of).openai },
		sealed: [{ loginFolder: of.folders.CLAUDE_CONFIG_DIR, name: "claude-2", vendor: "anthropic" }],
	});
	assert.strictEqual(logins, `${loginFolders(of).open}\n`, "the login ran in a folder of its own");
	yield* enterpriseRerun(of);
}).pipe(Effect.scoped);

const headless = Effect.gen(function* headless() {
	const fs = yield* FileSystem.FileSystem;
	const of = yield* world;

	yield* fs.writeFileString(`${of.fakeHarnessFolder}/next-sign-in.json`, enterpriseStatus);

	const run = yield* setUp(of, "claude", [
		{ after: questions.baa, typed: down },
		noAnother,
		judgeKey,
		loginCode,
		enter,
	]);

	const config = yield* writtenConfigOf(of);
	const logins = yield* loginsOf(of);
	const browserOpened = yield* fs.exists(`${of.fakeHarnessFolder}/browser-launches`);

	assert.strictEqual(run.exitCode, ok, run.shown);
	assert.include(run.shown, "Paste code here if prompted > CODE-123\n");
	assert.include(run.shown, "  Patient data    Claude Enterprise · dr.roe@clinic.example\n");
	assert.isTrue(notedOnce(run.shown), run.shown);
	assert.isFalse(browserOpened, "no browser opened");
	assert.strictEqual(logins, `${loginFolders(of).baa}\n`, "the login ran in a folder of its own");
	assert.deepStrictEqual(config, {
		clean: [{ forwarded: true, name: "claude-1", vendor: "anthropic" }],
		judge: { endpoint: "https://api.openai.com/v1", keyFile: keyFiles(of).openai },
		sealed: [{ loginFolder: loginFolders(of).baa, name: "claude-2", vendor: "anthropic" }],
	});
}).pipe(Effect.scoped);

const wrongSignIn = Effect.gen(function* wrongSignIn() {
	const fs = yield* FileSystem.FileSystem;
	const of = yield* world;

	yield* writeOwnSettings(of);

	const run = yield* setUp(of, "claude", [{ after: questions.baa, typed: down }, noAnother, judgeKey, loginCode]);
	const configWritten = yield* fs.exists(`${of.xdg.XDG_CONFIG_HOME}/phi-router/config.json`);
	const settings = yield* fs.readFileString(`${of.folders.CLAUDE_CONFIG_DIR}/settings.json`);

	assert.notStrictEqual(run.exitCode, ok, run.shown);
	assert.strictEqual(
		lastLine(run.shown),
		"You signed in to Claude Max · roe@example.com, not Claude Enterprise. Run setup again to sign in again.",
	);
	assert.isFalse(configWritten, "no account on any lane");
	assert.strictEqual(settings, ownSettings, "Claude Code's settings.json as it was");
}).pipe(Effect.scoped);

const onlyBaa = "You don't need phi-router. Your only account is already covered by your BAA. Nothing changed.";

const nothingElse = Effect.gen(function* nothingElse() {
	const of = yield* world;

	yield* withStatus(of, enterpriseStatus);

	const { after, before, run } = yield* tracked(
		of,
		["setup", "claude"],
		[covered, { after: questions.everyday, typed: down }],
	);

	assert.notStrictEqual(run.exitCode, ok, run.shown);
	assert.strictEqual(lastLine(run.shown), onlyBaa);
	assert.deepStrictEqual(after, before, "nothing changed");
}).pipe(Effect.scoped);

const macStop = "On macOS, phi-router can't add a second Claude sign-in yet";

const enterpriseOnMac = Effect.gen(function* enterpriseOnMac() {
	const of = yield* world;

	yield* withStatus(of, enterpriseStatus);
	yield* asDarwin(of);

	const { after, before, run } = yield* tracked(of, ["setup", "claude"], [covered]);

	assert.notStrictEqual(run.exitCode, ok, run.shown);
	assert.isTrue(Str.startsWith(macStop)(lastLine(run.shown)), run.shown);
	assert.deepStrictEqual(after, before, "nothing changed");
}).pipe(Effect.scoped);

it.layer(layer)("setup signs in to Claude", (test) => {
	test.effect(
		"an Enterprise login the BAA covers becomes the BAA account, a Claude Pro or Max login in a folder of its own becomes the everyday account, and a second run asks nothing and changes nothing",
		() => enterpriseSetUp,
		patient,
	);
	test.effect(
		"with no display and no browser, a Max login that picks a Claude Enterprise login reads the OpenAI key and the login code from the terminal and signs in to a folder of its own (no flow needs a login and two keys)",
		() => headless,
		patient,
	);
	test.effect(
		"a sign-in picked as the Claude Enterprise login that lands on another plan stops before any account is written",
		() => wrongSignIn,
		patient,
	);
	test.effect(
		"an Enterprise login the BAA covers with nothing else for everyday work stops: phi-router is not needed",
		() => nothingElse,
		patient,
	);
	test.effect(
		"on macOS an Enterprise login the BAA covers stops before any change: a second Claude sign-in needs the Keychain",
		() => enterpriseOnMac,
		patient,
	);
});
