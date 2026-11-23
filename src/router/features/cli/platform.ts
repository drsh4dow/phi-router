import { Context } from "effect";

/**
 * The platform layer the entry file provided, which only the entry file knows: its runtime, and the path of the entry
 * file itself, so `start` can launch `serve` on the same runtime and file.
 */
class Platform extends Context.Service<Platform, { readonly name: "bun" | "node"; readonly entry: string }>()(
	"phi-router/router/features/cli/platform",
) {}

export { Platform };
