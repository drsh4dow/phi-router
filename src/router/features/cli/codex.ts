import { Array, Console, Effect, Option, Path, Schema, String as Str, pipe } from "effect";
import { codexHome, removed, textOf } from "#router/client/codex.ts";
import {
	codexSettings,
	dotenvFile,
	dotted,
	exemptionLine,
	exemptionReason,
	holdsExemption,
	roleFile,
	sealedRole,
	withExemption,
	withoutExemption,
} from "./codex-settings.ts";
import { inlineOwner, switchedOff, switchedOn } from "./codex-config.ts";
import { hookTrust } from "./codex-holds.ts";
import { rewritePrivately } from "#router/client/private-file.ts";

class InlineTable extends Schema.TaggedError<InlineTable, { readonly brand: unique symbol }>()("InlineTable", {
	file: Schema.String,
	key: Schema.String,
}) {
	public override get message(): string {
		return `phi-router on codex: ${this.file} holds ${this.key} as one inline table, which on cannot add a key to. Write it as a [${this.key}] table and run phi-router on codex again.`;
	}
}

/** The files `on codex` and `off codex` change: `config.toml`, `.env` and the role file in Codex's home. */
const filesOf = Effect.fnUntraced(function* filesOf(named: string) {
	const path = yield* Path.Path;
	const home = yield* codexHome(named);

	return {
		config: path.join(home, "config.toml"),
		dotenv: path.join(home, dotenvFile),
		role: path.join(home, ...roleFile),
	};
});

/** Each setting `on codex` writes, with its reason. */
const settingLines = pipe(
	codexSettings,
	Array.flatMap(({ path, reason, value }) => [`${dotted(path)} = ${value}`, `  ${reason}`]),
);

/** Removes the router's exemption line from `.env`, and the file when the line was all it held. Gives whether it was there. */
const unexempt = Effect.fnUntraced(function* unexempt(file: string) {
	const text = yield* textOf(file);

	if (!holdsExemption(text)) {
		return false;
	}

	yield* Option.match(withoutExemption(text), {
		onNone: () => removed(file),
		onSome: (kept) => rewritePrivately(file, kept),
	});

	return true;
});

const trustLine = (config: string): string => {
	if (Str.isNonEmpty(hookTrust(config))) {
		return "The plugin's hooks are trusted.";
	}

	return 'Trust the plugin\'s hooks: start codex and pick "Trust all and continue" at "Hooks need review". Until you do, no hook starts the router, so every prompt ends in a connection error, and no hook blocks a prompt of a session that sends to another provider. A plugin update asks again.';
};

/** Writes `after` over `file`, which holds `before`, unless the two are the same. */
const changed = Effect.fnUntraced(function* changed(file: string, before: string, after: string) {
	if (after !== before) {
		yield* rewritePrivately(file, after);
	}
});

/**
 * Writes the settings a plugin cannot set into Codex's `config.toml`, keeping every other line, the router's exemption
 * from the developer's proxy into `.env`, and the pinned subagent's role into `agents/phi-sealed.toml`. A file that
 * holds what it would write already is not written. It gives the files and the new `config.toml`.
 */
const codexSwitchedOn = Effect.fnUntraced(function* codexSwitchedOn(named: string) {
	const files = yield* filesOf(named);
	const before = yield* textOf(files.config);
	const owner = inlineOwner(before);

	if (Option.isSome(owner)) {
		return yield* InlineTable.make({ file: files.config, key: owner.value });
	}

	const after = switchedOn(before);
	const [dotenv, role] = yield* Effect.all([textOf(files.dotenv), textOf(files.role)], { concurrency: 1 });

	const writes = [
		[files.config, before, after],
		[files.dotenv, dotenv, withExemption(dotenv)],
		[files.role, role, sealedRole],
	] as const;

	yield* Effect.forEach(writes, ([file, was, now]) => changed(file, was, now), { concurrency: 1, discard: true });

	return { after, files };
});

/** Writes what `codexSwitchedOn` writes, and prints each setting with its reason, and whether the human must still trust the plugin's hook. */
const onCodex = Effect.fn("on codex")(function* onCodex(named: string) {
	const { after, files } = yield* codexSwitchedOn(named);

	return yield* Console.log(
		Array.join(
			[
				`phi-router wrote ${String(codexSettings.length)} settings to ${files.config}`,
				...settingLines,
				`phi-router wrote ${exemptionLine} to ${files.dotenv}`,
				`  ${exemptionReason}`,
				`phi-router wrote the role phi-sealed to ${files.role}`,
				"  A plugin cannot ship a role. Codex runs the pinned subagent with it.",
				trustLine(after),
				"/model may not list phi/auto. Codex's background app-server reads the model list when it starts, before the hook starts the router. Whatever model you pick, every request goes through the router.",
				"Restart each open Codex session: it now sends to the router, which only a new session starts.",
				"Next: phi-router doctor codex",
			],
			"\n",
		),
	);
});

/**
 * Removes the lines `on codex` wrote, the exemption line in `.env` and the role file, and puts back each line of the
 * developer's that `on` replaced. It removes `.env` when the line was all it held, writes no file when that changes
 * nothing, and prints what it removed.
 */
const offCodex = Effect.fn("off codex")(function* offCodex(named: string) {
	const files = yield* filesOf(named);
	const before = yield* textOf(files.config);
	const { removed: keys, text } = switchedOff(before);

	if (text !== before) {
		yield* rewritePrivately(files.config, text);
	}

	const exempted = yield* unexempt(files.dotenv);
	const role = yield* removed(files.role);

	const roleLine = pipe(
		Option.liftPredicate(`phi-router removed the role phi-sealed from ${files.role}`, () => role),
		Option.toArray,
	);

	const exemptionLines = pipe(
		Option.liftPredicate(`phi-router removed ${exemptionLine} from ${files.dotenv}`, () => exempted),
		Option.toArray,
	);

	yield* Console.log(
		Array.join(
			[
				`phi-router removed ${String(keys.length)} settings from ${files.config}`,
				...keys,
				...exemptionLines,
				...roleLine,
			],
			"\n",
		),
	);
});

export { codexSwitchedOn, offCodex, onCodex };
