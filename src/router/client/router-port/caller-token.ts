import { Effect, FileSystem, Option, Path, Schema } from "effect";
import { Hex } from "effect/encoding";
import { SecureRandom } from "effect/crypto";
import { UserDirectories } from "effect/persistence";
import { createPrivately } from "#router/client/private-file.ts";
import { isWindows } from "#router/client/platform.ts";

const callerHeader = "x-phi-router-caller";

const tokenBytes = 32;

const Token = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));

class TokenGarbled extends Schema.TaggedError<TokenGarbled, { readonly brand: unique symbol }>()("TokenGarbled", {
	file: Schema.String,
}) {
	public override get message(): string {
		return `${this.file} holds no caller token. Remove it, then run phi-router on claude again.`;
	}
}

const tokenUsed = isWindows;

const tokenFile = Effect.gen(function* tokenFile() {
	const directories = yield* UserDirectories.UserDirectories;
	const path = yield* Path.Path;
	const state = yield* directories.state("phi-router");

	return path.join(state, "caller-token");
}).pipe(Effect.provideService(UserDirectories.UserDirectories, UserDirectories.make()));

const readToken = Effect.fnUntraced(function* readToken(file: string) {
	const fs = yield* FileSystem.FileSystem;
	const text = yield* fs.readFileString(file);

	return yield* Effect.mapError(Schema.decodeEffect(Token)(text), () => TokenGarbled.make({ file }));
});

const storedToken = tokenFile.pipe(Effect.flatMap(readToken));

const freshToken = Effect.fnUntraced(
	function* freshToken(file: string) {
		const random = yield* SecureRandom.SecureRandom;
		const bytes = yield* random.randomBytes(tokenBytes);
		const made = Hex.encode(bytes);

		return yield* createPrivately(file, made).pipe(
			Effect.as(made),
			Effect.catchReason("PlatformError", "AlreadyExists", () => readToken(file)),
		);
	},
	Effect.provideService(SecureRandom.SecureRandom, SecureRandom.make(SecureRandom.randomBytesUnsafe)),
);

const ensuredToken = Effect.gen(function* ensuredToken() {
	const path = yield* Path.Path;

	if (!tokenUsed(path)) {
		return Option.none<string>();
	}

	const file = yield* tokenFile;

	const token = yield* readToken(file).pipe(Effect.catchReason("PlatformError", "NotFound", () => freshToken(file)));

	return Option.some(token);
});

export { callerHeader, ensuredToken, storedToken, tokenUsed };
