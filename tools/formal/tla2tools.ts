import { Effect, FileSystem, Path, Schema } from "effect";
import { Digest } from "effect/crypto";

const tlcVersion = "1.7.4";

const tlcRelease = {
	file: `node_modules/.cache/tlaplus/tla2tools-${tlcVersion}.jar`,
	sha256: "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88",
	url: `https://github.com/tlaplus/tlaplus/releases/download/v${tlcVersion}/tla2tools.jar`,
};

class JarNotPinned extends Schema.TaggedError<JarNotPinned, { readonly brand: unique symbol }>()("JarNotPinned", {
	message: Schema.String,
}) {}

const jarFile = Effect.gen(function* jarFile() {
	const path = yield* Path.Path;

	return path.resolve(import.meta.dirname, "../..", tlcRelease.file);
});

const isPinned = Effect.fn("isPinned")(function* isPinned(
	file: string,
): Effect.fn.Return<boolean, never, FileSystem.FileSystem | Digest.Digest> {
	const fs = yield* FileSystem.FileSystem;
	const digest = yield* Digest.Digest;
	const bytes = yield* fs.readFile(file).pipe(Effect.orElseSucceed(() => new Uint8Array()));
	const hex = yield* digest.digestHex(Digest.sha256, bytes);

	return hex === tlcRelease.sha256;
});

const pinnedJar = Effect.gen(function* pinnedJar() {
	const file = yield* jarFile;
	const pinned = yield* isPinned(file);

	if (!pinned) {
		return yield* JarNotPinned.make({
			message: `${file} is missing or does not match its pinned checksum. Run \`bun install\`, which downloads it.`,
		});
	}

	return file;
});

export { isPinned, jarFile, pinnedJar, tlcRelease };
