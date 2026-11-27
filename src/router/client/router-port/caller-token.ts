import { Effect, FileSystem, Option, Path, Record, Schema } from "effect";
import { Hex } from "effect/encoding";
import { SecureRandom } from "effect/crypto";
import { UserDirectories } from "effect/persistence";
import { writePrivately } from "#router/client/private-file.ts";

const callerHeader = "x-phi-router-caller";

const tokenBytes = 32;

const Token = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));

const windowsSeparator = "\\";

type Headers = Readonly<Record<string, string>>;

const noHeaders: Headers = Record.empty<string, string>();

const tokenFile = Effect.gen(function* tokenFile() {
	const directories = yield* UserDirectories.UserDirectories;
	const path = yield* Path.Path;
	const state = yield* directories.state("phi-router");

	return path.join(state, "caller-token");
}).pipe(Effect.provideService(UserDirectories.UserDirectories, UserDirectories.make()));

const storedToken = Effect.gen(function* storedToken() {
	const fs = yield* FileSystem.FileSystem;
	const file = yield* tokenFile;
	const text = yield* fs.readFileString(file);

	return yield* Schema.decodeEffect(Token)(text);
});

const freshToken = Effect.gen(function* freshToken() {
	const random = yield* SecureRandom.SecureRandom;
	const bytes = yield* random.randomBytes(tokenBytes);
	const made = Hex.encode(bytes);
	const file = yield* tokenFile;

	yield* writePrivately(file, made);

	return made;
}).pipe(Effect.provideService(SecureRandom.SecureRandom, SecureRandom.make(SecureRandom.randomBytesUnsafe)));

const callerToken = Effect.gen(function* callerToken() {
	const found = yield* Effect.option(storedToken);

	if (Option.isSome(found)) {
		return found.value;
	}

	return yield* freshToken;
});

const ensuredToken = Effect.gen(function* ensuredToken() {
	const path = yield* Path.Path;

	if (path.sep !== windowsSeparator) {
		return Option.none<string>();
	}

	const token = yield* callerToken;

	return Option.some(token);
});

const tokenHeaders = (token: string): Headers => Record.singleton(callerHeader, token);

const callerHeaders: Effect.Effect<Headers> = Effect.gen(function* callerHeaders() {
	const fs = yield* Effect.serviceOption(FileSystem.FileSystem);
	const path = yield* Effect.serviceOption(Path.Path);

	if (Option.isNone(fs) || Option.isNone(path) || path.value.sep !== windowsSeparator) {
		return noHeaders;
	}

	return yield* storedToken.pipe(
		Effect.map(tokenHeaders),
		Effect.provideService(FileSystem.FileSystem, fs.value),
		Effect.provideService(Path.Path, path.value),
		Effect.orElseSucceed(() => noHeaders),
	);
});

export { callerHeader, callerHeaders, ensuredToken, storedToken };
