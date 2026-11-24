import { Array, Effect, Option, Schema, Struct, pipe } from "effect";
import { assert, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import type { VendorLanes } from "#router/client/configuration/index.ts";
import { laneConfiguration } from "#router/client/configuration/index.ts";

const judge = { endpoint: "http://127.0.0.1:9/v1", keyEnv: "PHI_TEST_JUDGE_KEY" };

const accounts = {
	anthropicBaa: { keyEnv: "PHI_TEST_BAA_KEY", name: "anthropic-baa", scheme: "apiKey", vendor: "anthropic" },
	anthropicFile: {
		keyFile: "/home/u/.config/phi-router/keys/anthropic",
		name: "anthropic-baa",
		scheme: "apiKey",
		vendor: "anthropic",
	},
	anthropicOpen: { forwarded: true, name: "claude-max", vendor: "anthropic" },
	claudeFolder: { loginFolder: "/home/u/.local/share/phi-logins/claude-2", name: "claude-2", vendor: "anthropic" },
	codexFolder: { loginFolder: "/home/u/.local/share/phi-logins/codex-2", name: "codex-2", vendor: "openai" },
	openaiBaa: { keyEnv: "PHI_TEST_BAA_KEY", name: "openai-baa", scheme: "apiKey", vendor: "openai" },
	openaiOpen: { forwarded: true, name: "chatgpt", vendor: "openai" },
} as const;

const both = {
	clean: [accounts.anthropicOpen, accounts.openaiOpen],
	judge,
	sealed: [accounts.anthropicBaa, accounts.openaiBaa],
	targetModel: { anthropic: "claude-target", openai: "gpt-target" },
};

const jsonOf = Schema.encodeEffect(Schema.fromJsonString(Schema.Json));

const configuredAs = <Shown>(
	text: string,
	show: (lanes: VendorLanes) => Shown,
): Effect.Effect<Option.Option<Readonly<Record<"anthropic" | "openai", Option.Option<Shown>>>>> =>
	Effect.option(
		Effect.map(laneConfiguration(text), ({ anthropic, openai }) => ({
			anthropic: pipe(anthropic, Option.map(show)),
			openai: pipe(openai, Option.map(show)),
		})),
	);

const configured = Effect.fnUntraced(function* configured(text: string) {
	return yield* configuredAs(text, ({ clean, sealed, targetModel }) => [
		...Array.flatMap([...clean, ...sealed], (account) => [account.name, account.endpoint]),
		targetModel,
	]);
});

const modelsOf = Effect.fnUntraced(function* modelsOf(text: string) {
	return yield* configuredAs(text, ({ clean, sealed, sealedModel }) => [
		sealedModel,
		...pipe(
			[...clean, ...sealed],
			Array.flatMap((account) => [account.name, Array.join(account.lacks, ",")]),
		),
	]);
});

const anthropicApi = "https://api.anthropic.com";

const codexApi = "https://chatgpt.com/backend-api/codex";

const anthropicLanes = ["claude-max", anthropicApi, "anthropic-baa", anthropicApi, "claude-target"];

const openaiLanes = ["chatgpt", codexApi, "openai-baa", "https://api.openai.com/v1", "gpt-target"];

const sideBySide = Effect.gen(function* sideBySide() {
	const lanes = yield* Effect.flatMap(jsonOf(both), configured);

	const aloneFile = Struct.assign(both, {
		clean: [accounts.anthropicOpen],
		sealed: [accounts.anthropicBaa],
		targetModel: { anthropic: "claude-target" },
	});

	const alone = yield* Effect.flatMap(jsonOf(aloneFile), configured);

	const foldersFile = Struct.assign(both, {
		clean: [accounts.anthropicOpen, accounts.codexFolder, accounts.openaiOpen, accounts.claudeFolder],
	});

	const folders = yield* Effect.flatMap(jsonOf(foldersFile), configured);

	const defaultedFile = Struct.assign(Struct.omit(both, ["targetModel"]), {
		sealed: [accounts.anthropicFile, accounts.openaiBaa],
	});

	const defaulted = yield* Effect.flatMap(jsonOf(defaultedFile), configured);

	assert.deepStrictEqual(
		{ alone, defaulted, folders, lanes },
		{
			alone: Option.some({ anthropic: Option.some(anthropicLanes), openai: Option.none() }),
			defaulted: Option.some({
				anthropic: Option.some(["claude-max", anthropicApi, "anthropic-baa", anthropicApi, "claude-opus-5-5"]),
				openai: Option.some(["chatgpt", codexApi, "openai-baa", "https://api.openai.com/v1", "gpt-6.1-sol"]),
			}),
			folders: Option.some({
				anthropic: Option.some([
					"claude-max",
					anthropicApi,
					"claude-2",
					anthropicApi,
					"anthropic-baa",
					anthropicApi,
					"claude-target",
				]),
				openai: Option.some(["codex-2", codexApi, ...openaiLanes]),
			}),
			lanes: Option.some({ anthropic: Option.some(anthropicLanes), openai: Option.some(openaiLanes) }),
		},
	);
});

const sameName = Struct.assign(accounts.openaiOpen, { name: accounts.anthropicBaa.name });

const relativeFolder = Struct.assign(accounts.codexFolder, { loginFolder: "phi-logins/codex-2" });

const oauthBaa = Struct.assign(accounts.openaiBaa, { scheme: "oauth" });

const lackingOpen = Struct.assign(accounts.anthropicOpen, { lacks: ["claude-haiku-5-5"] });

const lackingFolder = Struct.assign(accounts.codexFolder, { lacks: ["codex-auto-review"] });

const lackingSealed = Struct.assign(accounts.anthropicBaa, { lacks: ["claude-sealed"] });

const lackingTarget = Struct.assign(accounts.openaiBaa, { lacks: ["gpt-target"] });

const lackingDefault = Struct.assign(accounts.openaiBaa, { lacks: ["gpt-6.1-sol"] });

const relativeKeyFile = Struct.assign(accounts.anthropicFile, { keyFile: "keys/anthropic" });

const twoCredentials = Struct.assign(accounts.codexFolder, { keyEnv: "PHI_TEST_BAA_KEY" });

const refused = Effect.gen(function* refused() {
	const files = [
		Struct.assign(both, { sealed: [accounts.anthropicBaa] }),
		Struct.assign(Struct.omit(both, ["targetModel"]), { sealed: [accounts.anthropicBaa, lackingDefault] }),
		Struct.assign(both, { sealed: [relativeKeyFile, accounts.openaiBaa] }),
		Struct.assign(both, { clean: [accounts.anthropicOpen, sameName] }),
		Struct.assign(both, { clean: [accounts.anthropicOpen, accounts.openaiOpen, relativeFolder] }),
		Struct.assign(both, { sealed: [accounts.anthropicBaa, oauthBaa] }),
		Struct.assign(both, { clean: [lackingOpen, accounts.openaiOpen] }),
		Struct.assign(both, { clean: [accounts.anthropicOpen, lackingFolder] }),
		Struct.assign(both, { sealed: [lackingSealed, accounts.openaiBaa], sealedModel: { anthropic: "claude-sealed" } }),
		Struct.assign(both, { sealed: [accounts.anthropicBaa, lackingTarget] }),
		Struct.assign(both, { clean: [accounts.anthropicOpen, accounts.openaiOpen, twoCredentials] }),
	];

	const lanes = yield* Effect.forEach(files, (file) => Effect.flatMap(jsonOf(file), configured), { concurrency: 1 });

	assert.deepStrictEqual(lanes, Array.replicate(Option.none(), files.length));
});

const lackingBaa = Struct.assign(accounts.anthropicBaa, { lacks: ["claude-haiku-5-5", "claude-target"] });

const substitutes = Effect.gen(function* substitutes() {
	const before = yield* Effect.flatMap(jsonOf(both), modelsOf);

	const lackingFile = Struct.assign(both, {
		sealed: [lackingBaa, accounts.openaiBaa],
		sealedModel: { anthropic: "claude-sealed" },
	});

	const lacking = yield* Effect.flatMap(jsonOf(lackingFile), modelsOf);
	const openai = Option.some(["gpt-target", "chatgpt", "", "openai-baa", ""]);

	assert.deepStrictEqual(
		{ before, lacking },
		{
			before: Option.some({
				anthropic: Option.some(["claude-target", "claude-max", "", "anthropic-baa", ""]),
				openai,
			}),
			lacking: Option.some({
				anthropic: Option.some([
					"claude-sealed",
					"claude-max",
					"",
					"anthropic-baa",
					"claude-haiku-5-5,claude-target",
				]),
				openai,
			}),
		},
	);
});

it.layer(NodeServices.layer)("the lanes in config.json", (test) => {
	test.effect(
		"hold both vendors side by side, or one alone, each lane a list in file order with its own endpoints, and each vendor's default target model when the file names none",
		() => sideBySide,
	);
	test.effect(
		"refuse a vendor missing from a lane, two accounts of one name, a relative login folder or key file, an account that names two credentials, an OpenAI OAuth key, an open account of either vendor that lacks a model and a BAA account that lacks its sealedModel or, with none, its target model",
		() => refused,
	);
	test.effect(
		"give each BAA account the models it lacks, and each vendor its sealedModel or else its targetModel, from a file with or without either field",
		() => substitutes,
	);
});
