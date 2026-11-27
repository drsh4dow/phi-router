import { Effect, FileSystem, Option, Path, Schema } from "effect";
import { Hex } from "effect/encoding";
import { SecureRandom } from "effect/crypto";
import { UserDirectories } from "effect/persistence";
import { writePrivately } from "#router/client/private-file.ts";

const callerHeader = "x-phi-router-caller";

const tokenBytes = 32;

const Token = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));

const windowsSeparator = "\\";

const tokenUsed = (path: Path.Path): boolean => path.sep === windowsSeparator;

const tokenFile = Effect.gen(function* tokenFile() {
	const directories = yield* UserDirectories.UserDirectories;
	const path = yield* Path.Path;
	const state = yield* directories.state("phi-router");

	return path.join(state, "caller-token");
}).pipe(Effect.provideService(UserDirectories.UserDirectories, UserDirectories.make()));

const readToken = Effect.fnUntraced(function* readToken(file: string) {
	const fs = yield* FileSystem.FileSystem;
	const text = yield* fs.readFileString(file);

	return yield* Schema.decodeEffect(Token)(text);
});

const storedToken = tokenFile.pipe(Effect.flatMap(readToken));

const freshToken = Effect.fnUntraced(
	function* freshToken(file: string) {
		const random = yield* SecureRandom.SecureRandom;
		const bytes = yield* random.randomBytes(tokenBytes);
		const made = Hex.encode(bytes);

		yield* writePrivately(file, made);

		return made;
	},
	Effect.provideService(SecureRandom.SecureRandom, SecureRandom.make(SecureRandom.randomBytesUnsafe)),
);

const ensuredToken = Effect.gen(function* ensuredToken() {
	const path = yield* Path.Path;

	if (!tokenUsed(path)) {
		return Option.none<string>();
	}

	const file = yield* tokenFile;

	const token = yield* readToken(file).pipe(Effect.catch(() => freshToken(file)));

	return Option.some(token);
});

export { callerHeader, ensuredToken, storedToken, tokenUsed };
