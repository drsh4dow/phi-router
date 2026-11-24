import { Array, Config, Effect, Option, Record, Schema, String as Str, pipe } from "effect";
import type { Pid } from "#shared/cli.ts";
import { SessionId } from "#shared/cli.ts";
import { modelAddress } from "./claude-settings.ts";
import { standardInput } from "#router/client/standard-input.ts";
import { start } from "./start.ts";
import { userSettings } from "#router/client/harnesses/index.ts";

/** What a session-start hook reads on its stdin, as far as a lease needs it. The harness's field names stay here. */
const HookInput = Schema.fromJsonString(Schema.Struct({ cwd: Schema.String, session_id: SessionId }));

/** A model address that names a router: the literal loopback, a port, and nothing after but a slash. */
const routerAddress = /^http:\/\/127\.0\.0\.1:(?<port>\d+)\/?$/u;

/**
 * The port of a model address `on claude` or `doctor claude` could have written, and none for any other text: an
 * empty value, `localhost`, `https`, another host or a path.
 *
 * @param {string} address The model address.
 * @returns {Option.Option<number>} The port.
 */
const portOf = (address: string): Option.Option<number> =>
	pipe(
		Option.fromNullishOr(routerAddress.exec(address)),
		Option.flatMap(({ groups }) => Option.fromNullishOr(groups)),
		Option.map(({ port = "" }) => Number(port)),
	);

/** The switches that send Claude Code 2.1.330's model requests to another provider instead of its model address. */
const providerSwitches = [
	"CLAUDE_CODE_USE_BEDROCK",
	"CLAUDE_CODE_USE_VERTEX",
	"CLAUDE_CODE_USE_FOUNDRY",
	"CLAUDE_CODE_USE_ANTHROPIC_AWS",
	"CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
	"CLAUDE_CODE_USE_MANTLE",
	"CLAUDE_CODE_USE_GATEWAY",
] as const;

/** The harness whose hook runs, by whether it passed `--claude`. */
const hookHarness = { false: "codex", true: "claude" } as const;

/** The values Claude Code reads a switch as on by, once trimmed and lowercased. */
const switchedOn = ["1", "true", "yes", "on"];

/** A setting of the session moves a protected Claude Code instance's model requests off the router. */
class MovedOff extends Schema.TaggedError<MovedOff, { readonly brand: unique symbol }>()("MovedOff", {
	setting: Schema.String,
}) {
	public override get message(): string {
		return `phi-router: ${this.setting} moves this Claude Code session off the router, so the hook stopped it. A repository's .claude/settings.json or .claude/settings.local.json can set it. Remove it there, or run phi-router off claude.`;
	}
}

/**
 * The setting that moves a protected Claude Code instance off the router, if one does. The instance is protected when its
 * model address `address` names a router, or when the user settings' does, as `on claude` writes it. Its model address
 * must then be the user settings' one, and no provider switch may be on.
 */
const movedBy = Effect.fnUntraced(function* movedBy(address: string) {
	const settings = yield* userSettings("");

	const installed = pipe(
		Record.get(settings.env, modelAddress),
		Option.filter((value) => Option.isSome(portOf(value))),
	);

	const values = yield* Effect.forEach(
		providerSwitches,
		(name) => Effect.map(Config.String(name).pipe(Config.withDefault("")), (value) => ({ name, value })),
		{ concurrency: 1 },
	);

	const switched = pipe(
		values,
		Array.findFirst(({ value }) => Array.contains(switchedOn, Str.toLowerCase(Str.trim(value)))),
		Option.map(({ name }) => name),
	);

	return Option.match(installed, {
		onNone: () =>
			pipe(
				switched,
				Option.filter(() => Option.isSome(portOf(address))),
			),
		onSome: (value) =>
			pipe(
				Option.some(modelAddress),
				Option.filter(() => value !== address),
				Option.orElse(() => switched),
			),
	});
});

/**
 * The session-start hook's command. `address` is the model address the instance will use. For a Claude Code instance,
 * `claude`, it first fails when the session's settings move a protected instance off the router. When the address names
 * no router, the instance is not protected, and this returns at once and reads nothing. Otherwise it reads the hook's
 * JSON from stdin and runs `start` for the instance's pid with its session id and folder, on the address's port, with the
 * lines Claude Code or Codex shows. Like `start`, it prints nothing on success.
 */
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

export { portOf, sessionStart };
