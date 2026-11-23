import { Array, Effect, FileSystem, Option, Predicate, Schema, Struct, pipe } from "effect";
import { absent, configFile } from "./configuration.ts";
import type { Credential } from "./credentials.ts";
import { UserDirectories } from "effect/persistence";

/** The vendor whose wire an account speaks: Anthropic Messages, or OpenAI Responses. */
const Vendors = Schema.Literals(["anthropic", "openai"]);

type Vendor = typeof Vendors.Type;

/** One of the two lanes of `config.json`. */
type Lane = "clean" | "sealed";

/**
 * One account of a lane, its name unique in the file. `endpoint` is the file's, or the vendor's own when the file names
 * none. `lacks` names the models a BAA account does not carry, and is empty on an open account.
 */
interface NamedAccount {
	readonly vendor: Vendor;
	readonly name: string;
	readonly endpoint: string;
	readonly credential: Credential;
	readonly lacks: readonly string[];
}

/**
 * One vendor's side of the two lanes: its open accounts and its BAA accounts, each in the file's order, the model
 * `phi/auto` stands for there, and the substitute, the file's `sealedModel` or else that target model.
 */
interface VendorLanes {
	readonly clean: Array.NonEmptyReadonlyArray<NamedAccount>;
	readonly sealed: Array.NonEmptyReadonlyArray<NamedAccount>;
	readonly targetModel: string;
	readonly sealedModel: string;
}

/**
 * The vendor's own address when the file names no `endpoint`. A forwarded OpenAI login and a Codex home folder are
 * ChatGPT logins.
 */
const endpoints = {
	anthropic: {
		forwarded: "https://api.anthropic.com",
		key: "https://api.anthropic.com",
		loginFolder: "https://api.anthropic.com",
	},
	openai: {
		forwarded: "https://chatgpt.com/backend-api/codex",
		key: "https://api.openai.com/v1",
		loginFolder: "https://chatgpt.com/backend-api/codex",
	},
} as const satisfies Record<Vendor, Record<Credential["kind"], string>>;

const named = {
	endpoint: Schema.optionalKey(Schema.String),
	lacks: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
	name: Schema.NonEmptyString,
};

const perVendor = Schema.Struct({
	anthropic: Schema.optionalKey(Schema.NonEmptyString),
	openai: Schema.optionalKey(Schema.NonEmptyString),
});

const absolutePath = Schema.NonEmptyString.check(Schema.isPattern(/^\//u));

/** An account names one credential: each of these but its own is absent. */
const noCredential = { forwarded: absent, keyCommand: absent, keyEnv: absent, keyFile: absent, loginFolder: absent };

const byEnv = Struct.assign(noCredential, { keyEnv: Schema.NonEmptyString });

const byCommand = Struct.assign(noCredential, { keyCommand: Schema.NonEmptyString });

const byFile = Struct.assign(noCredential, { keyFile: absolutePath });

/** An Anthropic key is an API key or a long-lived OAuth token. An OpenAI key is an API key. */
const anthropicKey = { scheme: Schema.Literals(["apiKey", "oauth"]), vendor: Schema.Literal("anthropic") };

const openaiKey = { scheme: Schema.Literal("apiKey"), vendor: Schema.Literal("openai") };

const forwarded = Struct.assign(noCredential, { forwarded: Schema.Literal(true), scheme: absent, vendor: Vendors });

const Forwarded = Schema.Struct(Struct.assign(named, forwarded));

/** A login folder by its absolute path. Its vendor says which credential file the router reads in it. */
const LoginFolder = Schema.Struct(
	Struct.assign(named, Struct.assign(noCredential, { loginFolder: absolutePath, scheme: absent, vendor: Vendors })),
);

const anthropicKeyed = Struct.assign(named, anthropicKey);

const openaiKeyed = Struct.assign(named, openaiKey);

const Account = Schema.Union([
	Forwarded,
	LoginFolder,
	Schema.Struct(Struct.assign(anthropicKeyed, byEnv)),
	Schema.Struct(Struct.assign(anthropicKeyed, byCommand)),
	Schema.Struct(Struct.assign(anthropicKeyed, byFile)),
	Schema.Struct(Struct.assign(openaiKeyed, byEnv)),
	Schema.Struct(Struct.assign(openaiKeyed, byCommand)),
	Schema.Struct(Struct.assign(openaiKeyed, byFile)),
]);

type AccountEntry = typeof Account.Type;

const modelOr = (model: string): Schema.withDecodingDefaultKey<Schema.NonEmptyString> =>
	Schema.NonEmptyString.pipe(Schema.withDecodingDefaultKey(Effect.succeed(model)));

/** The model `phi/auto` stands for, per vendor: the file's, or else the vendor's default. */
const TargetModels = Schema.Struct({ anthropic: modelOr("claude-opus-5-5"), openai: modelOr("gpt-6.1-sol") }).pipe(
	Schema.withDecodingDefaultKey(Effect.succeed({})),
);

const Lanes = Schema.Struct({
	clean: Schema.NonEmptyArray(Account),
	sealed: Schema.NonEmptyArray(Account),
	sealedModel: Schema.optionalKey(perVendor),
	targetModel: TargetModels,
});

const countOf = (lane: readonly AccountEntry[], vendor: Vendor): number =>
	Array.countBy(lane, (entry) => entry.vendor === vendor);

const unnamed = 0;

/**
 * A vendor's substitute: the file's `sealedModel` for it, or else its target model, the file's or the vendor's default.
 *
 * @param {Lanes} lanes The decoded lanes.
 * @returns {Function} The substitute of a vendor.
 */
const sealedModelOf =
	(lanes: typeof Lanes.Type) =>
	(vendor: Vendor): string =>
		pipe(
			Option.fromUndefinedOr(lanes.sealedModel),
			Option.flatMapNullishOr((models) => models[vendor]),
			Option.getOrElse(() => lanes.targetModel[vendor]),
		);

/**
 * Each BAA account that lacks its vendor's substitute, which runs the models it lacks.
 *
 * @param {Lanes} lanes The decoded lanes.
 * @returns {readonly string[]} The problems.
 */
const lackingSubstitute = (lanes: typeof Lanes.Type): readonly string[] =>
	pipe(
		lanes.sealed,
		Array.flatMap((entry) =>
			pipe(
				Option.some(sealedModelOf(lanes)(entry.vendor)),
				Option.filter((model) => Array.contains(entry.lacks ?? [], model)),
				Option.map((model) => `account ${entry.name} lacks ${model}, the sealed model that runs what it lacks`),
				Option.toArray,
			),
		),
	);

const once = 1;

/**
 * Why the lanes cannot be served, or nothing. A vendor has at least one account in `clean` and one in `sealed`, or
 * none in either. No two accounts share a name, on either lane. Only a BAA account lacks a model,
 * since the clean lane runs every model a request names, and none lacks its vendor's substitute, which runs the models
 * it lacks.
 *
 * @param {Lanes} lanes The decoded lanes.
 * @returns {readonly string[]} The problems.
 */
const problemsOf = (lanes: typeof Lanes.Type): readonly string[] => {
	const vendors = pipe(
		Vendors.literals,
		Array.flatMap((vendor) => {
			const inClean = countOf(lanes.clean, vendor) > unnamed;

			if (inClean === countOf(lanes.sealed, vendor) > unnamed) {
				return [];
			}

			return [`vendor ${vendor} needs an account in clean and an account in sealed, or none in either`];
		}),
	);

	const names = Array.map([...lanes.clean, ...lanes.sealed], (entry) => entry.name);

	const twice = pipe(
		Array.dedupe(names),
		Array.filter((name) => Array.countBy(names, (other) => other === name) > once),
		Array.map((name) => `two accounts are named ${name}`),
	);

	const lacking = pipe(
		lanes.clean,
		Array.filter((entry) => Predicate.isNotUndefined(entry.lacks)),
		Array.map((entry) => `account ${entry.name} is on the clean lane, which runs every model, so it lacks none`),
	);

	return [...vendors, ...twice, ...lacking, ...lackingSubstitute(lanes)];
};

const LaneFile = Schema.fromJsonString(Lanes.check(Schema.makeFilter(problemsOf)));

const credentialOf = (entry: AccountEntry): Credential => {
	if (entry.forwarded === true) {
		return { kind: "forwarded" };
	}

	if (Schema.is(LoginFolder)(entry)) {
		return { folder: entry.loginFolder, kind: "loginFolder" };
	}

	return { kind: "key", scheme: entry.scheme, source: entry };
};

const namedAccount = (entry: AccountEntry): NamedAccount => {
	const credential = credentialOf(entry);
	const endpoint = entry.endpoint ?? endpoints[entry.vendor][credential.kind];

	return { credential, endpoint, lacks: entry.lacks ?? [], name: entry.name, vendor: entry.vendor };
};

const lanesOf =
	(lanes: typeof Lanes.Type) =>
	(vendor: Vendor): Option.Option<VendorLanes> => {
		const of = (lane: readonly AccountEntry[]): Option.Option<Array.NonEmptyReadonlyArray<NamedAccount>> =>
			pipe(
				lane,
				Array.filter((entry) => entry.vendor === vendor),
				Array.map(namedAccount),
				Array.match({ onEmpty: Option.none, onNonEmpty: Option.some }),
			);

		return Option.all({
			clean: of(lanes.clean),
			sealed: of(lanes.sealed),
			sealedModel: Option.some(sealedModelOf(lanes)(vendor)),
			targetModel: Option.some(lanes.targetModel[vendor]),
		});
	};

/** Per vendor, its two lanes, or none when the file names no account of it. */
type LaneConfiguration = Readonly<Record<Vendor, Option.Option<VendorLanes>>>;

const byVendor = (lanes: typeof Lanes.Type): LaneConfiguration => {
	const of = lanesOf(lanes);

	return { anthropic: of("anthropic"), openai: of("openai") };
};

/**
 * What a `config.json` text says about the lanes: per vendor, the open accounts and the BAA accounts in the file's
 * order, the model `phi/auto` stands for, and the substitute. The file keeps two lists, which mix vendors,
 * and `targetModel` and `sealedModel` each name one model per vendor. Apart from `Configuration`, so a file that names
 * only the judge still serves `judge:probe`. It never holds a key, only the key's source or the login folder.
 *
 * @param {string} text The file's text.
 * @returns {Effect.Effect} The lanes, or why the router would refuse the file.
 */
const laneConfiguration = (text: string): Effect.Effect<LaneConfiguration, Schema.SchemaError> =>
	Effect.map(Schema.decodeEffect(LaneFile)(text), byVendor);

/** The decoded `config.json`, or none when there is no such file. A file the router would refuse fails. */
const configuredFile = Effect.gen(function* configuredFile() {
	const fs = yield* FileSystem.FileSystem;
	const file = yield* Effect.provideService(configFile, UserDirectories.UserDirectories, UserDirectories.make());
	const exists = yield* fs.exists(file);

	if (!exists) {
		return Option.none();
	}

	const text = yield* fs.readFileString(file);

	return yield* Schema.decodeEffect(LaneFile)(text).pipe(Effect.asSome);
});

/**
 * Each lane's accounts in the file's order, vendors mixed, or none when there is no `config.json`. A file the router
 * would refuse fails.
 */
const configuredAccounts = configuredFile.pipe(
	Effect.map(
		Option.map(({ clean, sealed }) => ({
			clean: pipe(clean, Array.map(namedAccount)),
			sealed: pipe(sealed, Array.map(namedAccount)),
		})),
	),
);

/** What `config.json` says about each vendor's lanes, or none when there is no such file. A refused file fails. */
const configuredLanes = configuredFile.pipe(Effect.map(Option.map(byVendor)));

export { LaneFile, configuredAccounts, configuredLanes, laneConfiguration };

export type { Lane, NamedAccount, Vendor, VendorLanes };
