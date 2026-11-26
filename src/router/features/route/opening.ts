import { Effect, Option } from "effect";
import type { Keep, Sealed } from "#router/features/border/index.ts";
import type { SealedPart, StoreFailed } from "#router/client/sealed-store.ts";
import type { PlatformError } from "effect";
import type { Serving } from "./harness.ts";
import { bridgesFor } from "#router/features/border/index.ts";
import { opened } from "#router/primitives/handle.ts";
import { pinnedInstructionsOf } from "#router/features/policy/index.ts";

type Opening = Effect.Effect<Pick<Sealed, "open" | "system">, StoreFailed | PlatformError.PlatformError>;

type Keeping = Keep<StoreFailed>;

interface Opened {
	readonly serving: Serving;
	readonly session: string;
	readonly pinned: boolean;
}

const noImages = 0;

const shown = ({ images, text }: SealedPart): string => {
	if (images === noImages) {
		return text;
	}

	return `${text}\n[${String(images)} image(s) of this part are not shown]`;
};

const systemOf = Effect.fnUntraced(function* systemOf({ pinned, serving, session }: Opened) {
	if (!pinned) {
		return bridgesFor[serving.wire.harness];
	}

	const folder = yield* serving.sealedStore.filesFolder(session);

	return pinnedInstructionsOf(folder);
});

const openingOf = (at: Opened): Opening =>
	Effect.gen(function* opening() {
		const kept = yield* at.serving.sealedStore.read(at.session);
		const system = yield* systemOf(at);

		return { open: opened((handle) => Option.map(kept.partOf(handle), shown)), system };
	});

export { openingOf };

export type { Keeping, Opening };
