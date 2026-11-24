import { Array, Effect, Result, pipe } from "effect";
import { assert, describe, it } from "@effect/vitest";
import { Base64 } from "effect/encoding";
import type { Message } from "./manifest.ts";
import { imageCases } from "./images.ts";
import { seeded } from "./random.ts";

const seed = 11;

const jpeg = new TextEncoder().encode("SOI, then the segments and the scan of the image");

const markerLength = 2;

const commentMarker = { first: 255, second: 254 } as const;

const lengthField = { base: 256, bytes: 2 } as const;

const commentSegment = (stamp: readonly number[]): number[] => {
	const length = stamp.length + lengthField.bytes;

	return [
		commentMarker.first,
		commentMarker.second,
		Math.floor(length / lengthField.base),
		length % lengthField.base,
		...stamp,
	];
};

const decoded = (base64: string): number[] => Array.fromIterable(Result.getOrThrow(Base64.decode(base64)));

const imageData = (message: Message): string[] => {
	if ("image" in message) {
		return [message.image.data];
	}

	return [];
};

const stampedImages = Effect.sync(() => {
	const cases = imageCases({
		images: { cleanScreenshot: jpeg, generatedFace: jpeg, namedClaimScreenshot: jpeg },
		rng: seeded(seed),
		used: new Set(),
	});

	const images = pipe(
		cases,
		Array.map(({ canaries, messages }) => ({
			canary: Array.headNonEmpty(canaries),
			data: pipe(messages, Array.flatMap(imageData), Array.join("")),
		})),
	);

	assert.isNotEmpty(images);
	assert.deepStrictEqual(
		pipe(
			images,
			Array.map(({ data }) => decoded(data)),
		),
		pipe(
			images,
			Array.map(({ canary }) =>
				Array.flatten([
					Array.take(jpeg, markerLength),
					commentSegment(decoded(canary)),
					Array.drop(jpeg, markerLength),
				]),
			),
		),
	);
});

describe("images", () => {
	it.effect(
		"an image case's JPEG holds its canary's stamp in a comment segment after the start-of-image marker, its length big-endian and counting itself",
		() => stampedImages,
	);
});
