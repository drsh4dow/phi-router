import { Array, Effect, FileSystem, Option, Predicate, Schema, Struct, pipe } from "effect";
import { absent, configFile, isAbsolutePath } from "./config-file.ts";
import type { KeySource } from "./config-file.ts";
import { UserDirectories } from "effect/persistence";

const Vendors = Schema.Literals(["anthropic", "openai"]);

type Vendor = typeof Vendors.Type;

type Credential =
	| { readonly kind: "forwarded" }
	| { readonly kind: "key"; readonly scheme: "apiKey" | "oauth"; readonly source: KeySource }
	| { readonly kind: "loginFolder"; readonly folder: string };

type Lane = "clean" | "sealed";

interface NamedAccount {
	readonly vendor: Vendor;
	readonly name: string;
	readonly endpoint: string;
	readonly credential: Credential;
	readonly lacks: readonly string[];
}

interface VendorLanes {
	readonly clean: Array.NonEmptyReadonlyArray<NamedAccount>;
	readonly sealed: Array.NonEmptyReadonlyArray<NamedAccount>;
	readonly targetModel: string;
	readonly sealedModel: string;
}

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

const absolutePath = Schema.NonEmptyString.check(isAbsolutePath);

const noCredential = { forwarded: absent, keyCommand: absent, keyEnv: absent, keyFile: absent, loginFolder: absent };

const byEnv = Struct.assign(noCredential, { keyEnv: Schema.NonEmptyString });

const byCommand = Struct.assign(noCredential, { keyCommand: Schema.NonEmptyString });

const byFile = Struct.assign(noCredential, { keyFile: absolutePath });

const anthropicKey = { scheme: Schema.Literals(["apiKey", "oauth"]), vendor: Schema.Literal("anthropic") };

const openaiKey = { scheme: Schema.Literal("apiKey"), vendor: Schema.Literal("openai") };

const forwarded = Struct.assign(noCredential, { forwarded: Schema.Literal(true), scheme: absent, vendor: Vendors });

const Forwarded = Schema.Struct(Struct.assign(named, forwarded));

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

const sealedModelOf =
	(lanes: typeof Lanes.Type) =>
	(vendor: Vendor): string =>
		pipe(
			Option.fromUndefinedOr(lanes.sealedModel),
			Option.flatMapNullishOr((models) => models[vendor]),
			Option.getOrElse(() => lanes.targetModel[vendor]),
		);

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

type LaneConfiguration = Readonly<Record<Vendor, Option.Option<VendorLanes>>>;

const byVendor = (lanes: typeof Lanes.Type): LaneConfiguration => {
	const of = lanesOf(lanes);

	return { anthropic: of("anthropic"), openai: of("openai") };
};

const laneConfiguration = (text: string): Effect.Effect<LaneConfiguration, Schema.SchemaError> =>
	Effect.map(Schema.decodeEffect(LaneFile)(text), byVendor);

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

const configuredAccounts = configuredFile.pipe(
	Effect.map(
		Option.map(({ clean, sealed }) => ({
			clean: pipe(clean, Array.map(namedAccount)),
			sealed: pipe(sealed, Array.map(namedAccount)),
		})),
	),
);

const configuredLanes = configuredFile.pipe(Effect.map(Option.map(byVendor)));

export { LaneFile, configuredAccounts, configuredLanes, endpoints, laneConfiguration };

export type { Credential, Lane, NamedAccount, Vendor, VendorLanes };
