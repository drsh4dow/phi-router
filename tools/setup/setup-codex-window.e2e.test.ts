import { Array, Effect, Option, String as Str, pipe } from "effect";
import { assert, it } from "@effect/vitest";
import {
	codexSignedIn,
	filesSetupMayChange,
	keyFiles,
	keysOutsideKeyFiles,
	lastLine,
	layer,
	ok,
	patient,
	withEnv,
	writtenConfigOf,
} from "./set-up.ts";
import { keys, typedRun, world } from "./world.ts";
import { phiRouter } from "#tools/cli/accounts-run.ts";
import { ran } from "#tools/lifecycle/launched.ts";

const answers = '{"baa":"key"}';

const agentApply = ["setup", "codex", "--apply", "--answers", answers];

const askedLine = `I need an OpenAI key covered by your BAA. In any terminal, run \`npx phi-router setup codex --apply --answers '${answers}'\` and paste it there, not here. Then follow its last line.`;

const codexDone = "Done. In Codex, type `/new`, then `/hooks` and press t to trust phi-router's hooks.";

const keyPrompt = "OpenAI key (BAA):";

const quoted = 1;

const partsAroundOnePrompt = 2;

const argsOfTerminal = Effect.fnUntraced(function* argsOfTerminal(line: string, env: Readonly<Record<string, string>>) {
	const command = pipe(
		Str.split(line, "`"),
		Array.get(quoted),
		Option.getOrElse(() => ""),
	);

	const parsed = yield* ran(["sh", "-c", `npx() { shift; printf '%s\\n' "$@"; }; ${command}`], env);

	return Str.split(Str.trimEnd(parsed.printed), "\n");
});

const typedInTerminal = Effect.gen(function* typedInTerminal() {
	const made = yield* world;
	const of = withEnv({ OPENAI_API_KEY: "sk-proj-unpicked-env-key" })(made);

	yield* codexSignedIn(of);

	const before = yield* filesSetupMayChange(of);
	const asked = yield* phiRouter(of.env, agentApply);
	const after = yield* filesSetupMayChange(of);

	assert.notStrictEqual(asked.exitCode, ok);
	assert.strictEqual(lastLine(asked.stderr), askedLine);
	assert.deepStrictEqual(after, before, "nothing changes before the key is in");

	const args = yield* argsOfTerminal(lastLine(asked.stderr), of.env);
	const terminal = yield* typedRun(of, args, [{ after: keyPrompt, typed: keys.openai }]);

	assert.strictEqual(terminal.exitCode, ok, terminal.shown);
	assert.lengthOf(Str.split(keyPrompt)(terminal.shown), partsAroundOnePrompt, "one hidden prompt");
	assert.strictEqual(lastLine(terminal.shown), codexDone);

	const config = yield* writtenConfigOf(of);
	const { openai } = keyFiles(of);
	const outside = yield* keysOutsideKeyFiles(of, [asked.stdout, asked.stderr, terminal.shown]);

	assert.deepNestedInclude(config, {
		judge: { endpoint: "https://api.openai.com/v1", keyFile: openai },
		"sealed[0].keyFile": openai,
	});
	assert.deepStrictEqual(outside, [], "no key outside its key file");
}).pipe(Effect.scoped);

it.layer(layer)("setup inside Codex", (test) => {
	test.effect(
		"with no key and no terminal, setup names the terminal command that asks for it once, for the BAA account and the PHI check",
		() => typedInTerminal,
		patient,
	);
});
