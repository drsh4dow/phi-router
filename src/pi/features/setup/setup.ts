import { Array, Effect, Option, Record, Ref, Schema, String as Str, Struct, pipe } from "effect";
import { CommandFailed, setupEnded } from "#shared/cli.ts";
import type { ExtensionAPI, ExtensionUIContext, ModelRegistry, SessionManager } from "@earendil-works/pi-coding-agent";
import type { KeyFieldFactory, Typed } from "./key-field.ts";
import type { SetupAnswersJson, SetupStepJson } from "#shared/cli.ts";
import { Router } from "#pi/client/router.ts";
import type { TypedKey } from "#pi/client/router.ts";
import { keyField } from "./key-field.ts";
import { piWire } from "#shared/pi.ts";

class SetupEnded extends Schema.TaggedError<SetupEnded, { readonly brand: unique symbol }>()("SetupEnded", {}) {}

type Answers = typeof SetupAnswersJson.Type;

type Step = typeof SetupStepJson.Type;

type Asked = Extract<Step, { kind: "ask" }>;

type Ready = Extract<Step, { kind: "ready" }>;

type Choice = Asked["question"]["choices"][number]["id"];

interface SetupContext {
	readonly cwd: string;
	readonly modelRegistry: Pick<ModelRegistry, "getAll">;
	readonly sessionManager: Pick<SessionManager, "getSessionId">;
	readonly ui: Ui;
}

type Ui = Pick<ExtensionUIContext, "notify" | "select" | "setWidget"> & {
	readonly custom: (field: KeyFieldFactory) => PromiseLike<Typed>;
};

const autoModel = "auto";

const progress = "phi-setup";

const noWidget = Option.getOrUndefined(Option.none<string[]>());

const switchedLine = "This session now runs on phi/auto. Models outside phi skip phi-router.";

const notSwitched = "Setup finished, but pi did not switch to phi/auto. Pick it in /model.";

const banner = "ERROR";

const failureText = (failed: Pick<CommandFailed, "cause">): string =>
	pipe(
		Str.split(String(failed.cause), "\n"),
		Array.map(Str.trim),
		Array.filter((line) => Str.isNonEmpty(line) && line !== banner),
		Array.join("\n"),
	);

const unprinted = (failed: Pick<CommandFailed, "cause" | "command">, printed: readonly string[]): CommandFailed => {
	const cause = pipe(
		Str.split(String(failed.cause), "\n"),
		Array.filter((line) => !Array.contains(printed, line)),
		Array.join("\n"),
	);

	return CommandFailed.make({ cause, command: failed.command });
};

const picked = (ui: Ui, question: Asked["question"]): Effect.Effect<Choice, SetupEnded> => {
	const labels = pipe(
		question.choices,
		Array.map(({ label }) => label),
	);

	return Effect.promise((): PromiseLike<string | undefined> => ui.select(question.text, labels)).pipe(
		Effect.map((label) => Array.findFirst(question.choices, (choice) => choice.label === label)),
		Effect.flatMap(Effect.fromOption),
		Effect.mapBoth({ onFailure: () => SetupEnded.make(), onSuccess: ({ id }) => id }),
	);
};

const settled = (
	ui: Ui,
	answers: Answers,
	step: Step,
): Effect.Effect<
	{ readonly answers: Answers; readonly step: Exclude<Step, Asked> },
	SetupEnded | CommandFailed,
	Router
> => {
	if (step.kind !== "ask") {
		return Effect.succeed({ answers, step });
	}

	return Effect.gen(function* asked() {
		const choice = yield* picked(ui, step.question);
		const next: Answers = Struct.assign(answers, Record.singleton(step.question.id, choice));
		const nextStep = yield* Router.use((client) => client.setupStep(next));

		return yield* settled(ui, next, nextStep);
	});
};

const typedKeys = (ui: Ui, keys: Ready["keys"]): Effect.Effect<readonly TypedKey[], SetupEnded> =>
	Effect.forEach(
		keys,
		({ prompt, vendor }) =>
			Effect.promise((): PromiseLike<Typed> =>
				ui.custom((...[tui, theme, _keybindings, done]) => keyField({ done, prompt, theme, tui })),
			).pipe(
				Effect.flatMap((typed) => {
					if (typed.kind === "ended") {
						return SetupEnded.make();
					}

					return Effect.succeed({ key: typed.key, vendor });
				}),
			),
		{ concurrency: 1 },
	);

const applied = Effect.fnUntraced(function* applied(
	ui: Ui,
	given: { readonly answers: Answers; readonly keys: readonly TypedKey[] },
) {
	const lines = yield* Ref.make<readonly string[]>([]);

	const shown = (line: string): Effect.Effect<void> =>
		Effect.map(Ref.updateAndGet(lines, Array.append(line)), (all) => {
			ui.setWidget(progress, [...all]);
		});

	yield* Router.use((client) => client.setUp({ answers: given.answers, keys: given.keys, shown })).pipe(
		Effect.ensuring(
			Effect.sync(() => {
				ui.setWidget(progress, noWidget);
			}),
		),
		Effect.catchTag("CommandFailed", (failed) =>
			Effect.flatMap(Ref.get(lines), (printed) => {
				if (Array.isReadonlyArrayNonEmpty(printed)) {
					ui.notify(Array.join(printed, "\n"), "info");
				}

				return Effect.fail(unprinted(failed, printed));
			}),
		),
	);

	return yield* Ref.get(lines);
});

const switched = Effect.fnUntraced(function* switched(
	ctx: SetupContext,
	given: { readonly port: number; readonly pi: Pick<ExtensionAPI, "setModel"> },
) {
	yield* Router.use((client) => client.start(ctx.sessionManager.getSessionId(), ctx.cwd, given.port));

	const model = Array.findFirst(
		ctx.modelRegistry.getAll(),
		({ id, provider }) => provider === piWire.provider && id === autoModel,
	);

	if (Option.isNone(model)) {
		return notSwitched;
	}

	const onAuto = yield* Effect.promise((): PromiseLike<boolean> => given.pi.setModel(model.value));

	if (onAuto) {
		return switchedLine;
	}

	return notSwitched;
});

const setUp: (given: {
	readonly port: number;
	readonly pi: Pick<ExtensionAPI, "setModel">;
}) => (ctx: SetupContext) => Effect.Effect<void, never, Router> =
	({ pi, port }) =>
	(ctx) =>
		Effect.gen(function* setUpInPi() {
			const first = yield* Router.use((client) => client.setupStep({}));

			ctx.ui.notify(pipe(first.found, Array.join("\n")), "info");

			const { answers, step } = yield* settled(ctx.ui, {}, first);

			if (step.kind === "stop") {
				ctx.ui.notify(pipe(step.found, Array.appendAll(["", step.line]), Array.join("\n")), "info");

				return;
			}

			const keys = yield* typedKeys(ctx.ui, step.keys);
			const lines = yield* applied(ctx.ui, { answers, keys });
			const closing = yield* switched(ctx, { pi, port });

			ctx.ui.notify(pipe(lines, Array.appendAll(["", closing]), Array.join("\n")), "info");
		}).pipe(
			Effect.catchTags({
				CommandFailed: (failed) =>
					Effect.sync(() => {
						ctx.ui.notify(failureText(failed), "error");
					}),
				SetupEnded: () =>
					Effect.sync(() => {
						ctx.ui.notify(setupEnded, "info");
					}),
			}),
		);

export { setUp };

export type { SetupContext };
