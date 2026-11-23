import {
	Array,
	Config,
	Effect,
	FileSystem,
	Formatter,
	Option,
	Record,
	Schedule,
	Schema,
	String as Str,
	Stream,
	Struct,
	pipe,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { freePort, ran } from "#tools/lifecycle/launched.ts";
import { TestClock } from "effect/testing";
import { mocked } from "#tools/route/mocked-router.ts";
import { pluginCopy } from "./copied.ts";
import { secretKept } from "#tools/lifecycle/squatter.ts";

/** What each harness writes to the hook of each event on its stdin. The prompt's canary must reach no listener. */
const hookInputs = {
	PreCompact: '{"session_id":"s-hook","cwd":"/work","hook_event_name":"PreCompact","trigger":"manual"}',
	SessionStart: '{"session_id":"s-hook","cwd":"/work","hook_event_name":"SessionStart","source":"startup"}',
	UserPromptSubmit:
		'{"session_id":"s-hook","cwd":"/work","hook_event_name":"UserPromptSubmit","prompt":"say ok phi-canary-36"}',
} as const;

type Event = keyof typeof hookInputs;

/** The events whose hook holds back what the harness would send to the port. */
type Blocking = Exclude<Event, "SessionStart">;

const deadProxy = "http://127.0.0.1:9";

const HookCommand = Schema.Struct({
	command: Schema.String,
	onFailure: Schema.optionalKey(Schema.Literal("block")),
	type: Schema.Literal("command"),
});

const Matcher = Schema.Struct({ hooks: Schema.Array(HookCommand) });

const Events = Schema.Struct({
	PreCompact: Schema.Tuple([Matcher]),
	SessionStart: Schema.Tuple([Matcher]),
	UserPromptSubmit: Schema.Tuple([Matcher]),
});

const Hooks = Schema.fromJsonString(Schema.Struct({ hooks: Events }));

/**
 * A stand-in instance: a shell that runs the hook as its child, as Claude Code does, writes the hook's stdout, stderr
 * and exit code to files, then becomes `sleep 300`, so `$PPID` in the hook is the instance's pid for good.
 */
const instanceScript = 'sh -c "$HOOK" >"$1" 2>"$2"; echo $? >"$3.part"; mv "$3.part" "$3"; exec sleep 300';

/** Where each harness finds the plugin's hook, and the names it gives the hook the plugin's folder and the address by. */
const harnesses = {
	claude: { address: "ANTHROPIC_BASE_URL", file: "hooks/hooks.json", root: "CLAUDE_PLUGIN_ROOT" },
	codex: { address: "PHI_ROUTER_ADDRESS", file: "hooks/codex.json", root: "PLUGIN_ROOT" },
} as const;

type Harness = keyof typeof harnesses;

const hookOf = Effect.fnUntraced(function* hookOf(copy: string, harness: Harness, event: Event) {
	const fs = yield* FileSystem.FileSystem;
	const text = yield* fs.readFileString(`${copy}/${harnesses[harness].file}`);
	const { hooks } = yield* Schema.decodeEffect(Hooks)(text);
	const [{ hooks: matched }] = hooks[event];

	return yield* Effect.fromOption(Array.findFirst(matched, ({ command }) => Str.includes(" session-start ")(command)));
});

const blocks = "2\n";

/** One run of a hook that guards what the harness sends: its harness, event, declaration, and what it printed. */
interface GuardRun {
	readonly harness: Harness;
	readonly event: Blocking;
	readonly hook: typeof HookCommand.Type;
	readonly printed: readonly string[];
}

/**
 * Whether the harness holds back the prompt or compaction after its hook printed what `run` holds. Codex stops a
 * compaction only on `"continue":false` on stdout, and blocks a prompt on exit 2. Claude Code blocks on exit 2, and on
 * any other failure of a hook marked `onFailure: "block"`.
 *
 * @param {GuardRun} run The hook's run.
 * @returns {boolean} Whether the harness holds it back.
 */
const blockedBy = (run: GuardRun): boolean => {
	const [stdout = "", , exitCode = ""] = run.printed;

	if (run.harness === "codex" && run.event === "PreCompact") {
		return exitCode === "0\n" && Str.includes('"continue":false')(stdout);
	}

	return exitCode === blocks || (run.harness === "claude" && run.hook.onFailure === "block" && exitCode !== "0\n");
};

const underInstance = Effect.fnUntraced(function* underInstance(env: Readonly<Record<string, string>>, stdin: string) {
	const fs = yield* FileSystem.FileSystem;
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const files = yield* fs.makeTempDirectoryScoped({ prefix: "phi-hook-" });
	const [out, err, code] = [`${files}/out`, `${files}/err`, `${files}/code`];
	const options = { env, extendEnv: false, stdin: Stream.encodeText(Stream.make(stdin)) };
	const instance = ChildProcess.make("sh", ["-c", instanceScript, "instance", out, err, code], options);
	const handle = yield* spawner.spawn(instance);

	yield* fs
		.exists(code)
		.pipe(
			Effect.repeat({ schedule: Schedule.spaced("50 millis"), until: (done) => done }),
			Effect.timeout("30 seconds"),
			TestClock.withLive,
		);

	const printed = yield* Effect.all([fs.readFileString(out), fs.readFileString(err), fs.readFileString(code)], {
		concurrency: 1,
	});

	return { end: handle.kill({ killSignal: "SIGKILL" }), pid: Number(handle.pid), printed };
});

type ModelAddress = Option.Option<string>;

const loopback = (port: number): ModelAddress => Option.some(`http://127.0.0.1:${String(port)}`);

const unset = (): ModelAddress => Option.none();

/**
 * A fresh Claude Code config folder whose user settings hold the model address `installed` gives for the router's
 * `port`, as `on claude` writes it.
 */
const claudeConfig = Effect.fnUntraced(function* claudeConfig(installed: (port: number) => ModelAddress, port: number) {
	const fs = yield* FileSystem.FileSystem;
	const config = yield* fs.makeTempDirectoryScoped({ prefix: "phi-hook-claude-" });

	const settings = Option.match(installed(port), {
		onNone: () => ({}),
		onSome: (url) => ({ env: { ANTHROPIC_BASE_URL: url } }),
	});

	yield* fs.writeFileString(`${config}/settings.json`, Formatter.formatJson(settings));

	return config;
});

/**
 * One run of a hook: the harness and event it is for, what its stdin holds, the model address the instance has, the one
 * Claude Code's user settings hold, as `on claude` writes it, and more of the instance's environment.
 */
interface HookRun {
	readonly harness: Harness;
	readonly event: Event;
	readonly stdin: string;
	readonly addressed: (port: number) => ModelAddress;
	readonly installed?: (port: number) => ModelAddress;
	readonly env?: Readonly<Record<string, string>>;
}

const hooked = Effect.fnUntraced(function* hooked({
	addressed,
	env: more = {},
	event,
	harness,
	installed = unset,
	stdin,
}: HookRun) {
	const copy = yield* pluginCopy;
	const hook = yield* hookOf(copy, harness, event);

	const { env: world, state } = yield* mocked({ holdsPhi: () => false }).pipe(
		Effect.tap((mocks) => secretKept(mocks.state)),
	);

	const [port, searchPath] = yield* Effect.all([freePort, Config.String("PATH")], { concurrency: 1 });
	const config = yield* claudeConfig(installed, port);

	yield* Effect.addFinalizer(() => ran(["pkill", "-9", "-f", copy], {}).pipe(Effect.orDie));

	const base = Struct.assign(Struct.assign(world, more), {
		[harnesses[harness].root]: copy,
		CLAUDE_CONFIG_DIR: config,
		HOME: copy,
		HOOK: hook.command,
		HTTPS_PROXY: deadProxy,
		HTTP_PROXY: deadProxy,
		NO_PROXY: "localhost",
		PATH: searchPath,
		http_proxy: deadProxy,
		https_proxy: deadProxy,
		no_proxy: "localhost",
	});

	const env = pipe(
		addressed(port),
		Option.match({ onNone: () => base, onSome: (url) => Record.set(base, harnesses[harness].address, url) }),
	);

	const instance = yield* underInstance(env, stdin);

	return Struct.assign(instance, { hook, port, state });
});

export { blockedBy, hookInputs, hooked, loopback, unset };

export type { Blocking, Event, Harness, ModelAddress };
