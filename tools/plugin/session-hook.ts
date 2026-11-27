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
import { freePort, stopMatching, windowsBasics } from "#tools/lifecycle/launched.ts";
import { TestClock } from "effect/testing";
import { mocked } from "#tools/route/mocked-router.ts";
import { pluginCopy } from "./copied.ts";
import { secretKept } from "#tools/lifecycle/squatter.ts";

const hookInputs = {
	PreCompact: '{"session_id":"s-hook","cwd":"/work","hook_event_name":"PreCompact","trigger":"manual"}',
	SessionStart: '{"session_id":"s-hook","cwd":"/work","hook_event_name":"SessionStart","source":"startup"}',
	UserPromptSubmit:
		'{"session_id":"s-hook","cwd":"/work","hook_event_name":"UserPromptSubmit","prompt":"say ok phi-canary-36"}',
} as const;

type Event = keyof typeof hookInputs;

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

const instanceScript = 'sh -c "$HOOK" >"$1" 2>"$2"; echo $? >"$3.part"; mv "$3.part" "$3"; exec sleep 300';

const windowsInstanceLines = [
	'const { spawnSync } = require("node:child_process");',
	'const fs = require("node:fs");',
	"const [out, err, code] = process.argv.slice(1);",
	"const env = { ...process.env, CLAUDE_PID: String(process.pid) };",
	'const stdio = ["inherit", fs.openSync(out, "w"), fs.openSync(err, "w")];',
	'const hooked = spawnSync("sh", ["-c", process.env.HOOK], { env, stdio });',
	String.raw`fs.writeFileSync(code + ".part", String(hooked.status) + "\n");`,
	'fs.renameSync(code + ".part", code);',
	"setTimeout(() => {}, 300_000);",
];

const instanceCommands: Readonly<Partial<Record<NodeJS.Platform, readonly [string, ...string[]]>>> = {
	win32: ["node", "-e", Array.join(windowsInstanceLines, "\n")],
};

const instanceCommand = instanceCommands[process.platform] ?? ["sh", "-c", instanceScript, "instance"];

const harnesses = {
	claude: {
		hooksFile: "hooks/hooks.json",
		modelAddressVariable: "ANTHROPIC_BASE_URL",
		pluginFolderVariable: "CLAUDE_PLUGIN_ROOT",
	},
	codex: {
		hooksFile: "hooks/codex.json",
		modelAddressVariable: "PHI_ROUTER_ADDRESS",
		pluginFolderVariable: "PLUGIN_ROOT",
	},
} as const;

type Harness = keyof typeof harnesses;

const hookOf = Effect.fnUntraced(function* hookOf(copy: string, harness: Harness, event: Event) {
	const fs = yield* FileSystem.FileSystem;
	const text = yield* fs.readFileString(`${copy}/${harnesses[harness].hooksFile}`);
	const { hooks } = yield* Schema.decodeEffect(Hooks)(text);
	const [{ hooks: matched }] = hooks[event];

	return yield* Effect.fromOption(Array.findFirst(matched, ({ command }) => Str.includes(" session-start ")(command)));
});

const blocks = "2\n";

interface GuardRun {
	readonly harness: Harness;
	readonly event: Blocking;
	readonly hook: typeof HookCommand.Type;
	readonly printed: readonly string[];
}

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
	const [runtime, ...args] = instanceCommand;
	const instance = ChildProcess.make(runtime, [...args, out, err, code], options);
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

interface HookRun {
	readonly harness: Harness;
	readonly event: Event;
	readonly stdin: string;
	readonly instanceAddress: (port: number) => ModelAddress;
	readonly userSettingsAddress?: (port: number) => ModelAddress;
	readonly instanceEnv?: Readonly<Record<string, string>>;
}

const hooked = Effect.fnUntraced(function* hooked({
	event,
	harness,
	instanceAddress,
	instanceEnv = {},
	stdin,
	userSettingsAddress = unset,
}: HookRun) {
	const copy = yield* pluginCopy;
	const hook = yield* hookOf(copy, harness, event);

	const { env: world, state } = yield* mocked({ holdsPhi: () => false }).pipe(
		Effect.tap((mocks) => secretKept(mocks.state)),
	);

	const [port, searchPath, basics] = yield* Effect.all([freePort, Config.String("PATH"), windowsBasics], {
		concurrency: 1,
	});

	const config = yield* claudeConfig(userSettingsAddress, port);

	yield* Effect.addFinalizer(() => stopMatching(copy).pipe(Effect.orDie));

	const base = Struct.assign(Struct.assign(Struct.assign(basics, world), instanceEnv), {
		[harnesses[harness].pluginFolderVariable]: copy,
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
		instanceAddress(port),
		Option.match({
			onNone: () => base,
			onSome: (url) => Record.set(base, harnesses[harness].modelAddressVariable, url),
		}),
	);

	const instance = yield* underInstance(env, stdin);

	return Struct.assign(instance, { hook, port, state });
});

export { blockedBy, harnesses, hookInputs, hooked, loopback, unset };

export type { Blocking, Event, Harness, ModelAddress };
