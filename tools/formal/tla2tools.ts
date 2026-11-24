import { Effect, FileSystem, Path, Schema } from "effect";
import { Digest } from "effect/crypto";

/** The TLC release the model check runs. Change the three together. */
const release = {
	file: "node_modules/.cache/tlaplus/tla2tools-1.7.4.jar",
	sha256: "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88",
	url: "https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar",
};

/** The jar is absent, or its bytes do not hash to the pinned checksum. */
class JarNotInstalled extends Schema.TaggedError<JarNotInstalled, { readonly brand: unique symbol }>()(
	"JarNotInstalled",
	{
		message: Schema.String,
	},
) {}

const jarFile = Effect.gen(function* jarFile() {
	const path = yield* Path.Path;

	return path.resolve(import.meta.dirname, "../..", release.file);
});

/** Whether a file holds the pinned release. A missing file does not. */
const isPinned = Effect.fn("isPinned")(function* isPinned(file: string) {
	const fs = yield* FileSystem.FileSystem;
	const digest = yield* Digest.Digest;
	const bytes = yield* fs.readFile(file).pipe(Effect.orElseSucceed(() => new Uint8Array()));
	const hex = yield* digest.digestHex(Digest.sha256, bytes);

	return hex === release.sha256;
});

/** The absolute path of the installed jar, once its bytes hash to the pinned checksum. Makes no network call. */
const installedJar = Effect.gen(function* installedJar() {
	const file = yield* jarFile;
	const pinned = yield* isPinned(file);

	if (!pinned) {
		return yield* JarNotInstalled.make({
			message: `${file} is missing or does not match its pinned checksum. Run \`bun install\`, which downloads it.`,
		});
	}

	return file;
});

export { installedJar, isPinned, jarFile, release };
