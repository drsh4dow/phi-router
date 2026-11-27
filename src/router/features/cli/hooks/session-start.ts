import { Config, Console, Effect, Option, Record, Redacted, Schema, String as Str, pipe } from "effect";
import { modelAddressSetting, providerSwitchOn } from "#router/features/cli/claude/index.ts";
import type { Pid } from "#shared/cli.ts";
import { SessionId } from "#shared/cli.ts";
import type { Vendor } from "#router/client/configuration/index.ts";
import { savePastedKey } from "#router/client/keys/index.ts";
import { standardInput } from "#router/client/standard-input.ts";
import { start } from "#router/features/cli/start.ts";
import { userSettings } from "#router/client/harnesses/index.ts";
import { waitNotice } from "#router/features/cli/newer-plugin.ts";

const HookInput = Schema.fromJsonString(
	Schema.Struct({ cwd: Schema.String, hook_event_name: Schema.optionalKey(Schema.String), session_id: SessionId }),
);

const Notice = Schema.fromJsonString(Schema.Struct({ systemMessage: Schema.String }));

const routerAddress = /^http:\/\/127\.0\.0\.1:(?<port>\d+)\/?$/u;

const portOf = (address: string): Option.Option<number> =>
	pipe(
		Option.fromNullishOr(routerAddress.exec(address)),
		Option.flatMap(({ groups }) => Option.fromNullishOr(groups)),
		Option.map(({ port = "" }) => Number(port)),
	);

const hookHarness = { false: "codex", true: "claude" } as const;

const pluginOptions = {
	anthropic: "CLAUDE_PLUGIN_OPTION_ANTHROPIC_KEY",
	openai: "CLAUDE_PLUGIN_OPTION_OPENAI_KEY",
} as const;

const pastedKeySaved = Effect.fnUntraced(function* pastedKeySaved([vendor, option]: readonly [Vendor, string]) {
	const pasted = yield* Config.Redacted(option).pipe(Config.withDefault(Redacted.make("")));
	const key = Str.trim(Redacted.value(pasted));

	if (Str.isNonEmpty(key)) {
		yield* savePastedKey(vendor, Redacted.make(key));
	}
});

const pastedKeysSaved = Effect.forEach(Record.toEntries(pluginOptions), pastedKeySaved, {
	concurrency: 1,
	discard: true,
});

class MovedOff extends Schema.TaggedError<MovedOff, { readonly brand: unique symbol }>()("MovedOff", {
	setting: Schema.String,
}) {
	public override get message(): string {
		return `phi-router: ${this.setting} moves this Claude Code session off the router, so the hook stopped it. A repository's .claude/settings.json or .claude/settings.local.json can set it. Remove it there, or run phi-router off claude.`;
	}
}

const movedBy = Effect.fnUntraced(function* movedBy(address: string) {
	const settings = yield* userSettings("");

	const installed = pipe(
		Record.get(settings.env, modelAddressSetting),
		Option.filter((value) => Option.isSome(portOf(value))),
	);

	const switched = yield* providerSwitchOn;

	return Option.match(installed, {
		onNone: () =>
			pipe(
				switched,
				Option.filter(() => Option.isSome(portOf(address))),
			),
		onSome: (value) =>
			pipe(
				Option.some(modelAddressSetting),
				Option.filter(() => value !== address),
				Option.orElse(() => switched),
			),
	});
});

const sessionStart = Effect.fn("session-start")(function* sessionStart(hook: {
	readonly pid: typeof Pid.Type;
	readonly address: string;
	readonly claude: boolean;
}) {
	if (hook.claude) {
		yield* pastedKeysSaved;

		const moved = yield* movedBy(hook.address);

		yield* Option.match(moved, {
			onNone: () => Effect.void,
			onSome: (setting) => Effect.fail(MovedOff.make({ setting })),
		});
	}

	const port = portOf(hook.address);

	if (Option.isNone(port)) {
		return;
	}

	const text = yield* standardInput;
	const input = yield* Schema.decodeEffect(HookInput)(text);

	const harness = hookHarness[`${hook.claude}`];

	const wait = yield* start({ folder: input.cwd, pid: hook.pid, session: input.session_id }, port.value, harness);

	if (!hook.claude && input.hook_event_name === "SessionStart" && Option.isSome(wait)) {
		const printed = yield* Schema.encodeEffect(Notice)({ systemMessage: waitNotice(wait.value) });

		yield* Console.log(printed);
	}
});

export { portOf, sessionStart };
