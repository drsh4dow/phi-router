import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { Config, Effect, FileSystem, Schema, Stream } from "effect";
import { assert, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import { pluginCopy } from "./copied.ts";

const patient = { timeout: 60_000 };

const ok = 0;

const blocking = 2;

const HookCommand = Schema.Struct({ command: Schema.String, type: Schema.Literal("command") });

const Matcher = Schema.Struct({ hooks: Schema.Tuple([HookCommand, HookCommand, HookCommand]) });

const Prompted = Schema.Struct({ UserPromptSubmit: Schema.Tuple([Matcher]) });

const Hooks = Schema.fromJsonString(Schema.Struct({ hooks: Prompted }));

const HookInput = Schema.fromJsonString(
	Schema.Struct({ prompt: Schema.String, session_id: Schema.String, transcript_path: Schema.String }),
);

const unrecordedInput = '{"prompt":"a prompt","session_id":"s-prompt","transcript_path":null}';

const sessionMeta = (provider: string): string =>
	`{"timestamp":"2026-11-22T10:43:10.000Z","type":"session_meta","payload":{"id":"s-prompt","cwd":"/work","originator":"codex_exec","cli_version":"0.166.0","model_provider":"${provider}"}}\n{"timestamp":"2026-11-22T10:43:11.000Z","type":"turn_context","payload":{"model":"phi/auto"}}\n`;

/** A copy of the plugin, and the command of its second prompt hook, whose trust key is `user_prompt_submit:0:1`. */
const promptHook = Effect.gen(function* promptHook() {
	const fs = yield* FileSystem.FileSystem;
	const copy = yield* pluginCopy;
	const text = yield* fs.readFileString(`${copy}/hooks/codex.json`);
	const { hooks } = yield* Schema.decodeEffect(Hooks)(text);
	const [{ hooks: matched }] = hooks.UserPromptSubmit;
	const [, { command }] = matched;

	return { command, copy };
});

/** Runs the prompt hook by `sh`, as Codex runs it, with `input` on its stdin, and gives its exit code and output. */
const prompted = Effect.fnUntraced(function* prompted(input: string) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const { command, copy } = yield* promptHook;
	const env = { HOME: copy, PATH: yield* Config.String("PATH"), PLUGIN_ROOT: copy };
	const stdin = Stream.encodeText(Stream.make(input));
	const handle = yield* spawner.spawn(ChildProcess.make("sh", ["-c", command], { env, extendEnv: false, stdin }));
	const stdout = Stream.mkString(Stream.decodeText(handle.stdout));
	const stderr = Stream.mkString(Stream.decodeText(handle.stderr));

	const [printed, errors, exitCode] = yield* Effect.all([stdout, stderr, handle.exitCode], {
		concurrency: "unbounded",
	});

	return { exitCode: Number(exitCode), stderr: errors, stdout: printed };
}, Effect.scoped);

/** Runs the prompt hook on a session whose transcript is `file`. */
const hookOn = Effect.fnUntraced(function* hookOn(file: string) {
	const input = yield* Schema.encodeEffect(HookInput)({
		prompt: "a prompt",
		session_id: "s-prompt",
		transcript_path: file,
	});

	return yield* prompted(input);
});

/** Runs the prompt hook on a session whose transcript holds `text`. */
const transcribed = Effect.fnUntraced(function* transcribed(text: string) {
	const fs = yield* FileSystem.FileSystem;
	const folder = yield* fs.makeTempDirectoryScoped({ prefix: "phi-router-rollout-" });
	const file = `${folder}/rollout.jsonl`;

	yield* fs.writeFileString(file, text);

	return yield* hookOn(file);
}, Effect.scoped);

const passed = Effect.gen(function* passed() {
	const hook = yield* transcribed(sessionMeta("phi"));

	assert.deepStrictEqual(hook, { exitCode: ok, stderr: "", stdout: "" });
});

const pastWholeRead = 4_294_967_296;

const longTranscript = Effect.gen(function* longTranscript() {
	const fs = yield* FileSystem.FileSystem;
	const folder = yield* fs.makeTempDirectoryScoped({ prefix: "phi-router-rollout-" });
	const file = `${folder}/rollout.jsonl`;

	yield* fs.writeFileString(file, sessionMeta("phi"));
	yield* fs.truncate(file, pastWholeRead);

	const hook = yield* hookOn(file);

	assert.deepStrictEqual(hook, { exitCode: ok, stderr: "", stdout: "" });
}).pipe(Effect.scoped);

const elsewhere = Effect.fnUntraced(function* elsewhere(provider: string) {
	const hook = yield* transcribed(sessionMeta(provider));

	assert.deepStrictEqual(hook, {
		exitCode: ok,
		stderr: "",
		stdout: `{"decision":"block","reason":"phi-router blocked this prompt: this session sends to the provider ${provider}, not to the router. Start a new session without -c model_provider or a profile that names another provider."}\n`,
	});
});

const unrecorded = Effect.gen(function* unrecorded() {
	const hook = yield* prompted(unrecordedInput);

	assert.deepStrictEqual(hook, {
		exitCode: ok,
		stderr: "",
		stdout:
			'{"decision":"block","reason":"phi-router blocked this prompt: Codex keeps no transcript of this session, as with --ephemeral, so phi-router cannot tell whether it sends to the router. Run codex without --ephemeral."}\n',
	});
});

const unreadable = "phi-router blocked this prompt: it could not read which provider this session sends to.\n";

const failedClosed = (hook: { readonly exitCode: number; readonly stderr: string }): void => {
	assert.deepStrictEqual({ exitCode: hook.exitCode, stderr: hook.stderr }, { exitCode: blocking, stderr: unreadable });
};

const missing = Effect.gen(function* missing() {
	const fs = yield* FileSystem.FileSystem;
	const folder = yield* fs.makeTempDirectoryScoped({ prefix: "phi-router-rollout-" });

	const hook = yield* hookOn(`${folder}/rollout.jsonl`);

	failedClosed(hook);
}).pipe(Effect.scoped);

const misread: readonly { readonly text: string; readonly what: string }[] = [
	{ text: "", what: "an empty transcript" },
	{
		text: '{"type":"turn_context","payload":{"model_provider":"phi"}}\n',
		what: "a transcript that opens with another line than session_meta",
	},
];

const misreadClosed = Effect.fnUntraced(function* misreadClosed(text: string) {
	const hook = yield* transcribed(text);

	failedClosed(hook);
});

it.layer(NodeServices.layer)("the Codex plugin's prompt hook", (test) => {
	test.effect("passes a prompt of a session whose transcript names the router's provider", () => passed, patient);
	test.effect(
		"passes a prompt from the transcript's first line when the rest is too long to read whole",
		() => longTranscript,
		patient,
	);
	test.effect.each(["openai", "other", "phi-router"])(
		"blocks a prompt of a session whose transcript names the provider %s",
		elsewhere,
		patient,
	);
	test.effect("blocks a prompt of a session Codex keeps no transcript of", () => unrecorded, patient);
	test.effect("exits 2 with its reason on stderr for a transcript that does not exist", () => missing, patient);
	test.effect.each(misread)("exits 2 with its reason on stderr for $what", ({ text }) => misreadClosed(text), patient);
});
