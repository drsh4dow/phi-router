import { Array, Effect, Function, Option, Predicate, Redacted, Struct, pipe } from "effect";
import { CommandFailed, setupEnded } from "#shared/cli.ts";
import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { SetupAnswersJson, SetupStepJson } from "#shared/cli.ts";
import { assert, it, vi } from "@effect/vitest";
import { Router } from "#pi/client/router.ts";
import type { SetupContext } from "./setup.ts";
import type { Typed } from "./key-field.ts";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { setUp } from "./setup.ts";

type Answers = typeof SetupAnswersJson.Type;

type Step = typeof SetupStepJson.Type;

const routerPort = 47_496;

const found = ["phi-router found", "  pi              Claude"];

const asksThenReady = (answers: Answers): Step => {
	if (!Predicate.hasProperty(answers, "baa")) {
		return {
			found,
			kind: "ask",
			question: {
				choices: [
					{ id: "key", label: "Anthropic API key" },
					{ id: "signIn", label: "Claude Enterprise login" },
				],
				id: "baa",
				text: "Which account does your BAA cover?",
			},
		};
	}

	return {
		found,
		keys: [
			{ prompt: "Anthropic key (BAA):", vendor: "anthropic" },
			{ prompt: "OpenAI key (PHI check):", vendor: "openai" },
		],
		kind: "ready",
	};
};

const apiKeyStop =
	"You don't need phi-router. It keeps patient data off a subscription with no BAA, and you're on an API key. Nothing changed.";

const stops = (): Step => ({
	found: ["phi-router found", "  pi              an API key"],
	kind: "stop",
	line: apiKeyStop,
});

const printed = ["✓ Anthropic key works", "✓ OpenAI key works", "", "  Patient data    Anthropic API key"];

const refusal =
	"✓ Anthropic key works\n\nERROR\n  The test failed, so pi was left as it was. Your key is saved. For details, run: npx phi-router doctor pi\n";

const anthropicKey = "sk-ant-api03-typed-in-pi";

const openaiKey = "sk-proj-typed-in-pi";

const ended: Typed = { kind: "ended" };

interface World {
	readonly steps: (answers: Answers) => Step;
	readonly escapes: boolean;
	readonly typed: readonly string[];
	readonly applyFails: boolean;
}

interface Applied {
	readonly answers: Answers;
	readonly keys: readonly (readonly [string, string])[];
}

const typedInto = (typed: readonly string[]): SetupContext["ui"]["custom"] => {
	const keys = [...typed];

	return (factory): PromiseLike<Typed> => {
		const given: Typed[] = [];

		const field = factory(
			{ requestRender: Function.constVoid },
			{ fg: (_color, text) => text },
			{ matches: () => false },
			(handed) => {
				given.push(handed);
			},
		);

		field.handleInput(keys.shift() ?? "\u001B");
		field.handleInput("\r");

		return Promise.resolve(Option.getOrElse(Array.head(given), () => ended));
	};
};

const ranIn = Effect.fnUntraced(function* ranIn(world: World) {
	const steps: Answers[] = [];
	const applied: Applied[] = [];
	const started: string[] = [];
	const notices: (readonly [string, string])[] = [];

	const failing = Effect.when(
		Effect.fail(CommandFailed.make({ cause: refusal, command: "setup" })),
		Effect.succeed(world.applyFails),
	);

	const router = Router.of({
		answerCheck: () => Effect.die("setup checks no answer"),
		models: Effect.succeed({}),
		setUp: ({ answers, keys, shown }) =>
			Effect.sync(() => {
				applied.push({
					answers,
					keys: pipe(
						keys,
						Array.map(({ key, vendor }) => [vendor, Redacted.value(key)] as const),
					),
				});
			}).pipe(
				Effect.andThen(Effect.forEach(printed, shown, { concurrency: 1, discard: true })),
				Effect.andThen(failing),
				Effect.asVoid,
			),
		setupStep: (answers) =>
			Effect.sync(() => {
				steps.push(answers);

				return world.steps(answers);
			}),
		start: (session, folder, port) =>
			Effect.sync(() => {
				started.push(`${session} ${folder} ${String(port)}`);
			}),
		statusline: () => Effect.die("setup asks no status"),
	});

	const picked = pipe(
		Option.some("Anthropic API key"),
		Option.filter(() => !world.escapes),
		Option.getOrUndefined,
	);

	const select = vi.fn<ExtensionUIContext["select"]>().mockResolvedValue(picked);
	const setWidget = vi.fn<(...shown: readonly unknown[]) => void>();
	const setModel = vi.fn<ExtensionAPI["setModel"]>().mockResolvedValue(true);

	const ctx: SetupContext = {
		cwd: "/work",
		modelRegistry: {
			getAll: () =>
				pipe(
					getBuiltinModels("anthropic"),
					Array.map((model) => Struct.assign(model, { id: "auto", provider: "phi" })),
				),
		},
		sessionManager: { getSessionId: (): string => "pi-session-1" },
		ui: {
			custom: typedInto(world.typed),
			notify: (text, kind = "info") => {
				notices.push([kind, text]);
			},
			select,
			setWidget,
		},
	};

	yield* Effect.provideService(setUp({ pi: { setModel }, port: routerPort })(ctx), Router, router);

	return {
		applied,
		models: pipe(
			setModel.mock.calls,
			Array.map(([model]) => `${model.provider}/${model.id}`),
		),
		notices,
		picks: select.mock.calls,
		started,
		steps,
		widgetCleared: pipe(
			Array.last(setWidget.mock.calls),
			Option.exists(([, lines]) => Predicate.isUndefined(lines)),
		),
	};
});

const printedAndStop = 2;

const pickedFirst = { applyFails: false, escapes: false, steps: asksThenReady };

it.effect(
	"/phi setup asks the BAA pick, takes each key in a masked field, sets up with both, and switches the session to phi/auto",
	() =>
		Effect.gen(function* setUpInPi() {
			const ran = yield* ranIn(Struct.assign(pickedFirst, { typed: [anthropicKey, openaiKey] }));

			assert.deepStrictEqual(ran.picks, [
				["Which account does your BAA cover?", ["Anthropic API key", "Claude Enterprise login"]],
			]);
			assert.deepStrictEqual(ran.steps, [{}, { baa: "key" }]);
			assert.deepStrictEqual(ran.applied, [
				{
					answers: { baa: "key" },
					keys: [
						["anthropic", anthropicKey],
						["openai", openaiKey],
					],
				},
			]);
			assert.deepStrictEqual(ran.started, ["pi-session-1 /work 47496"]);
			assert.deepStrictEqual(ran.models, ["phi/auto"]);
			assert.deepStrictEqual(ran.notices, [
				["info", "phi-router found\n  pi              Claude"],
				[
					"info",
					"✓ Anthropic key works\n✓ OpenAI key works\n\n  Patient data    Anthropic API key\n\nThis session now runs on phi/auto. Models outside phi skip phi-router.",
				],
			]);
			assert.isTrue(ran.widgetCleared);
		}),
);

it.effect("/phi setup shows what setup found with its stop line as setup prints it, and sets nothing up", () =>
	Effect.gen(function* stopped() {
		const ran = yield* ranIn({ applyFails: false, escapes: true, steps: stops, typed: [] });

		assert.deepStrictEqual(ran.steps, [{}]);
		assert.deepStrictEqual(ran.applied, []);
		assert.deepStrictEqual(ran.notices, [
			["info", "phi-router found\n  pi              an API key"],
			["info", `phi-router found\n  pi              an API key\n\n${apiKeyStop}`],
		]);
	}),
);

it.effect("/phi setup ends with nothing set up on Escape at the pick or at a key", () =>
	Effect.gen(function* escaped() {
		const atPick = yield* ranIn(Struct.assign(pickedFirst, { escapes: true, typed: [] }));
		const atKey = yield* ranIn(Struct.assign(pickedFirst, { typed: [anthropicKey] }));

		assert.deepStrictEqual(atPick.applied, []);
		assert.deepStrictEqual(atKey.applied, []);
		assert.deepStrictEqual(atKey.models, []);
		assert.deepStrictEqual(Array.last(atPick.notices), Option.some(["info", setupEnded] as const));
		assert.deepStrictEqual(Array.last(atKey.notices), Option.some(["info", setupEnded] as const));
	}),
);

it.effect(
	"/phi setup shows what a failed setup printed, then its stop line as the error, clears its progress and keeps the model",
	() =>
		Effect.gen(function* failed() {
			const ran = yield* ranIn(Struct.assign(pickedFirst, { applyFails: true, typed: [anthropicKey, openaiKey] }));

			assert.deepStrictEqual(ran.models, []);
			assert.deepStrictEqual(Array.takeRight(ran.notices, printedAndStop), [
				["info", "✓ Anthropic key works\n✓ OpenAI key works\n\n  Patient data    Anthropic API key"],
				[
					"error",
					"The test failed, so pi was left as it was. Your key is saved. For details, run: npx phi-router doctor pi",
				],
			]);
			assert.isTrue(ran.widgetCleared);
		}),
);
