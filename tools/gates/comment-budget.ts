import { Array, Console, Effect, FileSystem, Order, Path, Record, Result, Schema, String as Str, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { NodeRuntime, NodeServices } from "@effect/platform-node";

class BudgetBroken extends Schema.TaggedError<BudgetBroken, { readonly brand: unique symbol }>()("BudgetBroken", {
	message: Schema.String,
}) {}

const Start = Schema.Struct({ line: Schema.Int });

const FoundLine = Schema.fromJsonString(
	Schema.Struct({
		file: Schema.String,
		message: Schema.String,
		range: Schema.Struct({ start: Start }),
		ruleId: Schema.String,
	}),
);

type Found = typeof FoundLine.Type;

const BudgetText = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Int));

const Quoted = Schema.fromJsonString(Schema.String);

type Counts = Record.ReadonlyRecord<string, number>;

const commentRules = new Set(["no-comments", "no-comments-tsx"]);

const budgetFile = "tools/gates/comment-budget.json";

const pruneSwitch = "--prune";

const runtimeAndScript = 2;

const lineBase = 1;

const none = 0;

const where = (found: Found): string =>
	`${found.file}:${String(found.range.start.line + lineBase)}: ${found.ruleId}: ${found.message}`;

const budgetText = Effect.fn("budgetText")(function* budgetText(counts: Counts) {
	const sorted = Array.sortWith(Record.toEntries(counts), ([file]) => file, Order.String);

	const lines = yield* Effect.forEach(
		sorted,
		([file, count]) => Effect.map(Schema.encodeEffect(Quoted)(file), (quoted) => `\t${quoted}: ${String(count)}`),
		{ concurrency: 1 },
	);

	return `{\n${Array.join(lines, ",\n")}\n}\n`;
});

const scan = Effect.gen(function* scan() {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const handle = yield* spawner.spawn(ChildProcess.make("ast-grep", ["scan", "--json=stream", "src", "tools"]));
	const text = yield* Stream.mkString(Stream.decodeText(handle.stdout));
	const lines = Array.filter(Str.split(text, "\n"), Str.isNonEmpty);

	return yield* Effect.forEach(lines, (line) => Schema.decodeEffect(FoundLine)(line), { concurrency: 1 });
}).pipe(Effect.scoped);

const commentOrBreak = (found: Found): Result.Result<Found, string> => {
	if (commentRules.has(found.ruleId)) {
		return Result.succeed(found);
	}

	return Result.fail(where(found));
};

const overBudget = (comments: readonly Found[], counts: Counts, budget: Counts): readonly string[] =>
	Array.filterMap(comments, (found) => {
		if ((counts[found.file] ?? none) > (budget[found.file] ?? none)) {
			return Result.succeed(where(found));
		}

		return Result.failVoid;
	});

const underBudget = (counts: Counts, budget: Counts): readonly string[] =>
	Array.filterMap(Record.toEntries(budget), ([file, allowed]) => {
		const held = counts[file] ?? none;

		if (held < allowed) {
			return Result.succeed(`${file} holds ${String(held)} comments, under its budget of ${String(allowed)}.`);
		}

		return Result.failVoid;
	});

const program = Effect.gen(function* program() {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const found = yield* scan;
	const [comments, others] = Array.partition(found, commentOrBreak);

	const counts = Record.map(
		Array.groupBy(comments, (one) => one.file),
		(inFile) => inFile.length,
	);

	const committed = yield* fs.readFileString(path.resolve(budgetFile));
	const budget = yield* Schema.decodeEffect(BudgetText)(committed);
	const broken = [...others, ...overBudget(comments, counts, budget)];

	if (Array.isReadonlyArrayNonEmpty(broken)) {
		return yield* BudgetBroken.make({ message: Array.join(broken, "\n") });
	}

	if (Array.contains(Array.drop(process.argv, runtimeAndScript), pruneSwitch)) {
		const text = yield* budgetText(counts);

		return yield* fs.writeFileString(path.resolve(budgetFile), text);
	}

	const under = underBudget(counts, budget);

	if (Array.isReadonlyArrayNonEmpty(under)) {
		return yield* BudgetBroken.make({
			message: `${Array.join(under, "\n")}\nRun bun tools/gates/comment-budget.ts --prune and commit ${budgetFile}.`,
		});
	}

	return yield* Console.log(`${String(comments.length)} comments, none over the budget in ${budgetFile}.`);
});

NodeRuntime.runMain(program.pipe(Effect.provide(NodeServices.layer)));
