import { Effect, FileSystem, Path, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { isPinned, jarFile, pinnedJar, tlcRelease } from "./tla2tools.ts";
import { Digest } from "effect/crypto";

class ChecksumMismatch extends Schema.TaggedError<ChecksumMismatch, { readonly brand: unique symbol }>()(
	"ChecksumMismatch",
	{
		message: Schema.String,
	},
) {}

const fetchPart = Effect.gen(function* fetchPart() {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const client = yield* HttpClient.HttpClient;
	const file = yield* jarFile;
	const response = yield* HttpClient.filterStatusOk(client).get(tlcRelease.url);
	const body = yield* response.arrayBuffer;

	yield* fs.makeDirectory(path.dirname(file), { recursive: true });
	yield* fs.writeFile(`${file}.part`, new Uint8Array(body));

	return `${file}.part`;
});

const downloadPinned = Effect.gen(function* downloadPinned() {
	const fs = yield* FileSystem.FileSystem;
	const file = yield* jarFile;
	const part = yield* fetchPart;
	const pinned = yield* isPinned(part);

	if (!pinned) {
		return yield* ChecksumMismatch.make({ message: `${tlcRelease.url} does not hash to ${tlcRelease.sha256}.` });
	}

	return yield* fs.rename(part, file);
});

const install = Effect.catchTag(pinnedJar, "JarNotPinned", () => downloadPinned);

NodeRuntime.runMain(Effect.provide(install, [NodeServices.layer, FetchHttpClient.layer, Digest.layerWebCrypto]));
