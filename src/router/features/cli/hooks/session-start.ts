import { Array, Config, Effect, Option, Record, Schema, String as Str, pipe } from "effect";
import type { Pid } from "#shared/cli.ts";
import { SessionId } from "#shared/cli.ts";
import { modelAddressSetting } from "#router/features/cli/claude/index.ts";
import { standardInput } from "#router/client/standard-input.ts";
import { start } from "#router/features/cli/start.ts";
import { userSettings } from "#router/client/harnesses/index.ts";

const HookInput = Schema.fromJsonString(Schema.Struct({ cwd: Schema.String, session_id: SessionId }));

const routerAddress = /^http:\/\/127\.0\.0\.1:(?<port>\d+)\/?$/u;

const portOf = (address: string): Option.Option<number> =>
	pipe(
		Option.fromNullishOr(routerAddress.exec(address)),
		Option.flatMap(({ groups }) => Option.fromNullishOr(groups)),
		Option.map(({ port = "" }) => Number(port)),
	);

const providerSwitches = [
	"CLAUDE_CODE_USE_BEDROCK",
	"CLAUDE_CODE_USE_VERTEX",
	"CLAUDE_CODE_USE_FOUNDRY",
	"CLAUDE_CODE_USE_ANTHROPIC_AWS",
	"CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
	"CLAUDE_CODE_USE_MANTLE",
	"CLAUDE_CODE_USE_GATEWAY",
] as const;

const hookHarness = { false: "codex", true: "claude" } as const;

const switchedOn = ["1", "true", "yes", "on"];

const providerSwitchOn = Effect.gen(function* providerSwitchOn() {
	const values = yield* Effect.forEach(
		providerSwitches,
		(name) => Effect.map(Config.String(name).pipe(Config.withDefault("")), (value) => ({ name, value })),
		{ concurrency: 1 },
	);

	return pipe(
		values,
		Array.findFirst(({ value }) => Array.contains(switchedOn, Str.toLowerCase(Str.trim(value)))),
		Option.map(({ name }) => name),
	);
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

	yield* start({ folder: input.cwd, pid: hook.pid, session: input.session_id }, port.value, harness);
});

export { portOf, providerSwitchOn, sessionStart };
