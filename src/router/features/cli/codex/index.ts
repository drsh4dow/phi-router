import { Array, Console, Effect, Option, Path, Schema, String as Str, pipe } from "effect";
import { codexHome, removedIfPresent, rewritten, textOrEmpty } from "#router/client/harnesses/index.ts";
import {
	codexSettings,
	dotenvFile,
	dotted,
	exemptionLine,
	exemptionReason,
	holdsExemption,
	pinnedRoleFile,
	sealedRole,
	withExemption,
	withoutExemption,
} from "./settings.ts";
import { inlineOwner, switchedOff, switchedOn } from "./config.ts";
import { hookTrust } from "./holds.ts";

class InlineTable extends Schema.TaggedError<InlineTable, { readonly brand: unique symbol }>()("InlineTable", {
	file: Schema.String,
	key: Schema.String,
}) {
	public override get message(): string {
		return `phi-router on codex: ${this.file} holds ${this.key} as one inline table, which on cannot add a key to. Write it as a [${this.key}] table and run phi-router on codex again.`;
	}
}

const filesOf = Effect.fnUntraced(function* filesOf(named: string) {
	const path = yield* Path.Path;
	const home = yield* codexHome(named);

	return {
		config: path.join(home, "config.toml"),
		dotenv: path.join(home, dotenvFile),
		role: path.join(home, ...pinnedRoleFile),
	};
});

const settingsWithReasons = pipe(
	codexSettings,
	Array.flatMap(({ path, reason, value }) => [`${dotted(path)} = ${value}`, `  ${reason}`]),
);

const unexempt = Effect.fnUntraced(function* unexempt(file: string) {
	const text = yield* textOrEmpty(file);

	if (!holdsExemption(text)) {
		return false;
	}

	yield* Option.match(withoutExemption(text), {
		onNone: () => removedIfPresent(file),
		onSome: (kept) => rewritten(file, text, kept),
	});

	return true;
});

const trustLine = (config: string): string => {
	if (Str.isNonEmpty(hookTrust(config))) {
		return "The plugin's hooks are trusted.";
	}

	return 'Trust the plugin\'s hooks: start codex and pick "Trust all and continue" at "Hooks need review". Until you do, no hook starts the router, so every prompt ends in a connection error, and no hook blocks a prompt of a session that sends to another provider. A plugin update asks again.';
};

const codexSwitchedOn = Effect.fnUntraced(function* codexSwitchedOn(named: string) {
	const files = yield* filesOf(named);
	const before = yield* textOrEmpty(files.config);
	const owner = inlineOwner(before);

	if (Option.isSome(owner)) {
		return yield* InlineTable.make({ file: files.config, key: owner.value });
	}

	const after = switchedOn(before);
	const [dotenv, role] = yield* Effect.all([textOrEmpty(files.dotenv), textOrEmpty(files.role)], { concurrency: 1 });

	const writes = [
		[files.config, before, after],
		[files.dotenv, dotenv, withExemption(dotenv)],
		[files.role, role, sealedRole],
	] as const;

	yield* Effect.forEach(writes, ([file, was, now]) => rewritten(file, was, now), { concurrency: 1, discard: true });

	return { after, files };
});

const onCodex = Effect.fn("on codex")(function* onCodex(named: string) {
	const { after, files } = yield* codexSwitchedOn(named);

	return yield* Console.log(
		Array.join(
			[
				`phi-router wrote ${String(codexSettings.length)} settings to ${files.config}`,
				...settingsWithReasons,
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

const offCodex = Effect.fn("off codex")(function* offCodex(named: string) {
	const files = yield* filesOf(named);
	const before = yield* textOrEmpty(files.config);
	const { cutKeys: keys, text } = switchedOff(before);

	yield* rewritten(files.config, before, text);

	const exempted = yield* unexempt(files.dotenv);
	const role = yield* removedIfPresent(files.role);

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

export {
	addressEnv,
	codexSettings,
	doctorModel,
	dotenvFile,
	dotted,
	endsWithExemption,
	exemptionLine,
	pinnedRoleFile,
	pluginId,
	provider,
	sealedRole,
} from "./settings.ts";

export { holds, hookTrust, pluginEnabled } from "./holds.ts";

export { codexPrompt } from "./prompt.ts";
