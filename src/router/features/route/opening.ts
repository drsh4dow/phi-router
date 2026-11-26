import { Effect, Option } from "effect";
import type { Keep, Sealed } from "#router/features/border/index.ts";
import type { SealedPart, StoreFailed } from "#router/client/sealed-store.ts";
import type { PlatformError } from "effect";
import type { Reason } from "#router/client/lane-log.ts";
import type { Serving } from "./harness.ts";
import { bridgesFor } from "#router/features/border/index.ts";
import { opened } from "#router/primitives/handle.ts";
import { pinnedInstructionsOf } from "#router/features/policy/index.ts";

type Opening = Effect.Effect<Pick<Sealed, "added" | "open">, StoreFailed | PlatformError.PlatformError>;

type Keeping = Keep<StoreFailed>;

interface Opened {
	readonly serving: Serving;
	readonly session: string;
	readonly reason: Reason;
}

const noImages = 0;

const shown = ({ images, text }: SealedPart): string => {
	if (images === noImages) {
		return text;
	}

	return `${text}\n[${String(images)} image(s) of this part are not shown]`;
};

const addedOf = Effect.fnUntraced(function* addedOf({ reason, serving, session }: Opened) {
	if (reason === "BAA repo" || reason === "title") {
		return [];
	}

	if (reason !== "pinned") {
		return [bridgesFor[serving.wire.harness]];
	}

	const folder = yield* serving.sealedStore.filesFolder(session);

	return [pinnedInstructionsOf(folder)];
});

const openingOf = (at: Opened): Opening =>
	Effect.gen(function* opening() {
		const kept = yield* at.serving.sealedStore.read(at.session);
		const added = yield* addedOf(at);

		return { added, open: opened((handle) => Option.map(kept.partOf(handle), shown)) };
	});

export { openingOf };

export type { Keeping, Opening };
