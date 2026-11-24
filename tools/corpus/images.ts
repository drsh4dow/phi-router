import { Array, Effect, FileSystem, Path, pipe } from "effect";
import type { CleanCase, Entry, PhiCase } from "./manifest.ts";
import type { Image, Scene } from "./conversation.ts";
import type { Random, Used } from "./random.ts";
import { Base64 } from "effect/encoding";
import type { PlatformError } from "effect";
import { converse } from "./conversation.ts";
import { identifierKind } from "#router/features/policy/index.ts";
import { unique } from "./random.ts";

type Bytes = Readonly<Uint8Array<Readonly<ArrayBufferLike>>>;

interface Images {
	/** A StyleGAN portrait of nobody. */
	readonly face: Bytes;
	/** A claims screen showing a synthetic patient's full name and date of birth. */
	readonly claimScreenshot: Bytes;
	readonly cleanScreenshot: Bytes;
}

const loadImages = Effect.gen(function* loadImages() {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;

	const read = (name: string): Effect.Effect<Uint8Array, PlatformError.PlatformError> =>
		fs.readFile(path.join(import.meta.dirname, "images", name));

	return {
		claimScreenshot: yield* read("claim-screenshot.jpeg"),
		cleanScreenshot: yield* read("clean-screenshot.jpeg"),
		face: yield* read("face.jpeg"),
	} satisfies Images;
});

const imageEntries: Array.NonEmptyReadonlyArray<typeof Entry.Type> = ["user", "tool-result", "file-read", "steering"];

const stampLength = 30;

/** The bytes of the JPEG start-of-image marker, which the comment segment follows. */
const startOfImageBytes = 2;

const commentMarker = { first: 255, second: 254 } as const;

/** A segment's length field: two bytes, big-endian, counting themselves. */
const lengthField = { base: 256, bytes: 2 } as const;

/**
 * The JPEG with a comment segment holding `stamp` right after its start-of-image marker. The stamp starts at byte 6,
 * a multiple of 3, so its own base64 is a substring of the image's base64, which no other image in the file shares.
 *
 * @param {Bytes} jpeg The image.
 * @param {Bytes} stamp The bytes to stamp it with.
 * @returns {Uint8Array} The stamped image.
 */
const stamped = (jpeg: Bytes, stamp: Bytes): Uint8Array => {
	const length = stamp.length + lengthField.bytes;
	const bytes = Array.fromIterable(jpeg);

	return Uint8Array.from([
		...Array.take(bytes, startOfImageBytes),
		commentMarker.first,
		commentMarker.second,
		Math.floor(length / lengthField.base),
		length % lengthField.base,
		...stamp,
		...Array.drop(bytes, startOfImageBytes),
	]);
};

const jpeg = (bytes: Bytes): Image => ({ data: Base64.encode(Uint8Array.from(bytes)), mimeType: "image/jpeg" });

const screenshotScene: Scene = {
	asks: [
		"The claims grid renders this row wrong. Screenshot attached.",
		"Why does the denial screen show this? See the screenshot.",
		"The UI cuts off this row. Here's what the support agent sees.",
	],
	commands: ["playwright screenshot http://localhost:3000/claims/denials screenshots/claims-denials.jpeg"],
	paths: ["screenshots/claims-denials.jpeg"],
};

const photoScene: Scene = {
	asks: [
		"The intake upload rejects this patient photo. Is the file the problem?",
		"The badge printer crops this photo badly. Can you see why?",
		"The chart thumbnail renders this photo too dark. Here it is.",
	],
	commands: ["aws s3 cp s3://nfh-intake/photos/latest.jpeg photos/latest.jpeg"],
	paths: ["photos/latest.jpeg"],
};

const perImage = 20;

const perCleanScreenshot = 32;

const entryOf = (turn: number): typeof Entry.Type => Array.getUnsafe(imageEntries, turn % imageEntries.length);

const imageMessages = ({
	rng,
	scene,
	image,
	turn,
}: {
	readonly rng: Random;
	readonly scene: Scene;
	readonly image: Image;
	readonly turn: number;
}): ReturnType<typeof converse> =>
	converse({
		entry: entryOf(turn),
		image,
		parts: [rng.pick(scene.paths)],
		quotes: [],
		rng,
		scene,
	});

interface ImageRequest {
	readonly images: Images;
	readonly rng: Random;
	readonly used: Used;
}

/**
 * Cases whose identifier is an image: a face photo, and a screenshot showing a synthetic name and full date of birth.
 * Each case stamps its copy, so its canary is unique across the file.
 *
 * @param {ImageRequest} root0 The images, the draw source, and the canaries planted so far.
 * @param {Images} root0.images The images.
 * @param {Random} root0.rng The draw source.
 * @param {Used} root0.used The canaries planted so far.
 * @returns {readonly Omit<typeof PhiCase.Type, "id">[]} The cases.
 */
const imageCases = ({ images, rng, used }: ImageRequest): readonly Omit<typeof PhiCase.Type, "id">[] => {
	const sources = [
		{ bytes: images.face, identifier: identifierKind.facePhoto, scene: photoScene },
		{ bytes: images.claimScreenshot, identifier: identifierKind.patientName, scene: screenshotScene },
	] as const;

	return pipe(
		sources,
		Array.flatMap(({ identifier, bytes, scene }) =>
			Array.makeBy(perImage, (turn) => {
				const stamp = unique({ draw: () => rng.hex(stampLength), used });
				const image = jpeg(stamped(bytes, new TextEncoder().encode(stamp)));
				const messages = imageMessages({ image, rng, scene, turn });

				return {
					canaries: [Base64.encode(stamp)],
					expect: "phi",
					fragments: [],
					messages,
					strata: { carrier: "screenshot", entry: entryOf(turn), identifier, transform: "plain" },
				} as const;
			}),
		),
	);
};

const cleanImageCases = ({ images, rng }: Omit<ImageRequest, "used">): readonly Omit<typeof CleanCase.Type, "id">[] =>
	Array.makeBy(perCleanScreenshot, (turn) => ({
		canaries: [],
		expect: "clean",
		fragments: [],
		messages: imageMessages({ image: jpeg(images.cleanScreenshot), rng, scene: screenshotScene, turn }),
		strata: { negative: "clean-screenshot" },
	}));

export { cleanImageCases, imageCases, loadImages };

export type { Images };
