import { Effect, FileSystem, Path, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { installedJar, isPinned, jarFile, release } from "./tla2tools.ts";
import { Digest } from "effect/crypto";

class ChecksumMismatch extends Schema.TaggedError<ChecksumMismatch, { readonly brand: unique symbol }>()(
	"ChecksumMismatch",
	{
		message: Schema.String,
	},
) {}

/** Downloads the pinned TLC jar to a file beside its place, and returns that file. */
const fetchPart = Effect.gen(function* fetchPart() {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const client = yield* HttpClient.HttpClient;
	const file = yield* jarFile;
	const response = yield* HttpClient.filterStatusOk(client).get(release.url);
	const body = yield* response.arrayBuffer;

	yield* fs.makeDirectory(path.dirname(file), { recursive: true });
	yield* fs.writeFile(`${file}.part`, new Uint8Array(body));

	return `${file}.part`;
});

/**
 * Renames the download into place only when its bytes hash to the pinned checksum. `bun install`
 * runs this file through `prepare`.
 */
const download = Effect.gen(function* download() {
	const fs = yield* FileSystem.FileSystem;
	const file = yield* jarFile;
	const part = yield* fetchPart;
	const pinned = yield* isPinned(part);

	if (!pinned) {
		return yield* ChecksumMismatch.make({ message: `${release.url} does not hash to ${release.sha256}.` });
	}

	return yield* fs.rename(part, file);
});

/** Downloads nothing when the jar is already in place. */
const install = Effect.catchTag(installedJar, "JarNotInstalled", () => download);

NodeRuntime.runMain(Effect.provide(install, [NodeServices.layer, FetchHttpClient.layer, Digest.layerWebCrypto]));
