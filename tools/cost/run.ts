import {
	Array,
	Console,
	Effect,
	FileSystem,
	Number,
	Option,
	Order,
	Path,
	Predicate,
	Record,
	Schema,
	String as Str,
	pipe,
} from "effect";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { claimsQuery, subagentStep } from "./claims-query.ts";
import { fakes, mocked } from "#tools/route/mocked-router.ts";
import { claudeTurn } from "#tools/wire/claude-turn.ts";
import { isModelPost } from "#tools/wire/stored.ts";
import { routerProcess } from "#tools/route/router-process.ts";
import { succeeded } from "#tools/wire/checks.ts";

const runtimeAndScript = 2;

const defaultRuns = 3;

const runsFlag = "--runs=";

const half = 2;

const firstRun = 1;

const lowest = 0;

const executable = 0o755;

type Account = "open" | "baa";

interface Request {
	readonly account: Account;
	readonly step: string;
	readonly bytes: number;
	readonly holdsRows: boolean;
	readonly parts: Readonly<Record<"system" | "tools" | "messages", number>>;
}

interface Measured {
	readonly checkout: string;
	readonly exitCode: number;
	readonly finished: boolean;
	readonly requests: readonly Request[];
	readonly judge: { readonly calls: number; readonly bytes: number };
	readonly lanes: Readonly<Record<string, number>>;
}

const encoder = new TextEncoder();

const bytesOf = (text: string): number => encoder.encode(text).length;

const jsonText = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const decodeLane = Schema.decodeUnknownOption(
	Schema.fromJsonString(Schema.Struct({ lane: Schema.String, reason: Schema.String })),
);

const Parts = Schema.Struct({
	messages: Schema.Json,
	system: Schema.optionalKey(Schema.Json),
	tools: Schema.optionalKey(Schema.Json),
});

const decodeParts = Schema.decodeUnknownEffect(Schema.fromJsonString(Parts));

const partsOf = Effect.fnUntraced(function* partsOf(body: string) {
	const { messages, system = [], tools = [] } = yield* decodeParts(body);

	const [messagesText, systemText, toolsText] = yield* Effect.all(
		[jsonText(messages), jsonText(system), jsonText(tools)],
		{ concurrency: 1 },
	);

	return { messages: bytesOf(messagesText), system: bytesOf(systemText), tools: bytesOf(toolsText) };
});

const lanesIn = Effect.fnUntraced(function* lanesIn(state: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const text = yield* fs.readFileString(path.join(state, "lanes.jsonl"));

	return pipe(
		Str.split(text, "\n"),
		Array.map((line) => decodeLane(line)),
		Array.getSomes,
		Array.groupBy(({ lane, reason }) => `${lane} ${reason}`),
		Record.map(Array.length),
	);
});

const placed = Effect.fnUntraced(function* placed(checkout: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const home = yield* fs.makeTempDirectoryScoped({ prefix: "phi-cost-home-" });
	const config = yield* fs.makeTempDirectoryScoped({ prefix: "phi-cost-claude-" });
	const work = yield* fs.makeTempDirectoryScoped({ prefix: "phi-cost-work-" });
	const plugins = yield* fs.makeTempDirectoryScoped({ prefix: "phi-cost-plugin-" });
	const plugin = path.join(plugins, "claude");
	const scenario = claimsQuery(work);

	const written = Effect.fnUntraced(function* written([name, text]: readonly [string, string]) {
		const file = path.join(work, name);

		yield* fs.makeDirectory(path.dirname(file), { recursive: true });
		yield* fs.writeFileString(file, text, { mode: executable });
	});

	yield* fs.copy(path.join(checkout, "plugins", "claude"), plugin);
	yield* Effect.forEach(Record.toEntries(scenario.files), written, { concurrency: 1 });

	return { place: { config, home, plugin, work }, scenario };
});

const measured = Effect.fnUntraced(function* measured(checkout: string) {
	const { place, scenario } = yield* placed(checkout);

	const { env, mocks, state } = yield* mocked({
		baa: scenario.script,
		configExtras: { sealedModel: fakes.sealedModel },
		holdsPhi: scenario.holdsPhi,
		open: scenario.script,
	});

	const router = yield* routerProcess(["bun", "src/router/main.ts"], env, checkout);
	const folders = { XDG_CONFIG_HOME: env.XDG_CONFIG_HOME, XDG_STATE_HOME: env.XDG_STATE_HOME };

	const { exitCode, printed } = yield* claudeTurn({
		folders,
		place,
		prompt: scenario.prompt,
		router: router.url,
		session: [],
	});

	yield* router.kill;

	const requestOf = Effect.fnUntraced(function* requestOf(account: Account, body: string) {
		return {
			account,
			bytes: bytesOf(body),
			holdsRows: scenario.holdsPhi(body),
			parts: yield* partsOf(body),
			step: scenario.stepOf(body),
		} satisfies Request;
	});

	const requestsOf = (
		account: Account,
		sent: readonly { readonly body: string }[],
	): Effect.Effect<Request[], Schema.SchemaError> =>
		Effect.forEach(sent, ({ body }) => requestOf(account, body), { concurrency: 1 });

	const open = yield* mocks.open.received;
	const baa = yield* mocks.baa.received;
	const judged = yield* mocks.judge.received;
	const judgedText = yield* Effect.forEach(judged, ({ body }) => jsonText(body), { concurrency: 1 });

	return {
		checkout,
		exitCode,
		finished: Str.includes(scenario.report)(printed),
		judge: {
			bytes: Number.sumAll(
				pipe(
					judgedText,
					Array.map((text) => bytesOf(text)),
				),
			),
			calls: judged.length,
		},
		lanes: yield* lanesIn(state),
		requests: [
			...(yield* requestsOf("open", pipe(open, Array.filter(isModelPost)))),
			...(yield* requestsOf("baa", pipe(baa, Array.filter(isModelPost)))),
		],
	} satisfies Measured;
}, Effect.scoped);

const onAccount = (requests: readonly Request[], account: Account): readonly Request[] =>
	pipe(
		requests,
		Array.filter((request) => request.account === account),
	);

const bytesOn =
	(account: Account) =>
	(run: Measured): number =>
		Number.sumAll(
			pipe(
				onAccount(run.requests, account),
				Array.map(({ bytes }) => bytes),
			),
		);

const metrics = {
	"BAA bytes": bytesOn("baa"),
	"BAA requests": (run: Measured): number => onAccount(run.requests, "baa").length,
	"judge bytes": (run: Measured): number => run.judge.bytes,
	"judge calls": (run: Measured): number => run.judge.calls,
	"open bytes": bytesOn("open"),
	"open requests": (run: Measured): number => onAccount(run.requests, "open").length,
} as const;

const spreadOf = (values: readonly number[]): string => {
	const sorted = Array.sort(values, Order.Number);

	const at = (index: number): string =>
		pipe(Array.get(sorted, index), Option.match({ onNone: () => "none", onSome: String }));

	const median = at(Math.floor(sorted.length / half));
	const low = at(lowest);
	const high = at(sorted.length - firstRun);

	if (low === high) {
		return median;
	}

	return `${median} (${low} to ${high})`;
};

const runsOf = (runs: readonly Measured[], checkout: string): readonly Measured[] =>
	pipe(
		runs,
		Array.filter((run) => run.checkout === checkout),
	);

const tableOf = (runs: readonly Measured[], checkouts: readonly string[]): string => {
	const names = Record.keys(metrics);
	const rule = Array.join(Array.replicate("---", names.length), " | ");

	const rowOf = (checkout: string): string => {
		const own = runsOf(runs, checkout);

		const cells = pipe(
			names,
			Array.map((name) => spreadOf(pipe(own, Array.map(metrics[name])))),
		);

		return `| ${checkout} | ${String(own.length)} | ${Array.join(cells, " | ")} |`;
	};

	return Array.join(
		[
			`| router | runs | ${Array.join(names, " | ")} |`,
			`| --- | --- | ${rule} |`,
			...pipe(
				checkouts,
				Array.map((checkout) => rowOf(checkout)),
			),
		],
		"\n",
	);
};

const breakdownOf = Effect.fnUntraced(function* breakdownOf(run: Measured) {
	const lanes = yield* jsonText(run.lanes);

	const lines = pipe(
		run.requests,
		Array.map(
			({ account, bytes, holdsRows, parts, step }) =>
				`  ${account}\t${String(bytes)} bytes (system ${String(parts.system)}, tools ${String(parts.tools)}, messages ${String(parts.messages)})\trows ${String(holdsRows)}\tanswered with: ${step}`,
		),
	);

	return Array.join([`${run.checkout}, run 1, by request (lane log: ${lanes})`, ...lines], "\n");
});

const failuresOf = (run: Measured): readonly string[] => {
	const leaked = pipe(
		onAccount(run.requests, "open"),
		Array.some(({ holdsRows }) => holdsRows),
	);

	const blind = pipe(
		run.requests,
		Array.some(({ holdsRows, step }) => step === subagentStep && !holdsRows),
	);

	return pipe(
		[
			{ failed: run.exitCode !== succeeded, why: `Claude Code exited ${String(run.exitCode)}` },
			{ failed: !run.finished, why: "Claude Code never printed the report" },
			{ failed: leaked, why: "the open mock received the query rows" },
			{ failed: blind, why: "the pinned subagent did not receive the query rows" },
		],
		Array.filter(({ failed }) => failed),
		Array.map(({ why }) => `${run.checkout}: ${why}`),
	);
};

interface Args {
	readonly checkouts: readonly string[];
	readonly runs: number;
}

const isRunsFlag = Str.startsWith(runsFlag);

const runsIn = (flag: string): Option.Option<number> => Number.parse(Str.slice(runsFlag.length)(flag));

const argsOf = (given: readonly string[]): Args => ({
	checkouts: pipe(given, Array.filter(Predicate.not(isRunsFlag))),
	runs: pipe(
		given,
		Array.findFirst(isRunsFlag),
		Option.flatMap(runsIn),
		Option.getOrElse(() => defaultRuns),
	),
});

const program = Effect.gen(function* program() {
	const path = yield* Path.Path;
	const { checkouts, runs } = argsOf(Array.drop(process.argv, runtimeAndScript));

	if (!Array.isReadonlyArrayNonEmpty(checkouts)) {
		return yield* Effect.fail("bun run cost takes one or more router checkouts, each installed and built.");
	}

	const roots = pipe(
		checkouts,
		Array.map((checkout) => path.resolve(checkout)),
	);

	const one = Effect.fnUntraced(function* one(root: string, run: number) {
		const result = yield* measured(root);
		const bytes = metrics["BAA bytes"](result);
		const requests = metrics["BAA requests"](result);

		yield* Console.log(`run ${String(run)} ${root}: BAA ${String(bytes)} bytes in ${String(requests)} requests`);

		return result;
	});

	const all = yield* Effect.forEach(
		Array.makeBy(runs, (index) => index + firstRun),
		(run) => Effect.forEach(roots, (root) => one(root, run), { concurrency: 1 }),
		{ concurrency: 1 },
	);

	const flat = Array.flatten(all);

	const firsts = pipe(
		roots,
		Array.map((root) => Array.head(runsOf(flat, root))),
		Array.getSomes,
	);

	const breakdowns = yield* Effect.forEach(firsts, breakdownOf, { concurrency: 1 });

	const failures = pipe(
		flat,
		Array.flatMap((run) => failuresOf(run)),
	);

	yield* Console.log(Array.join(["claims-query cost", tableOf(flat, roots), ...breakdowns, ...failures], "\n\n"));

	return yield* Effect.filterOrFail(
		Effect.succeed(failures),
		Array.isReadonlyArrayEmpty,
		() => "a claims-query run failed",
	);
});

NodeRuntime.runMain(program.pipe(Effect.provide(NodeServices.layer)));
