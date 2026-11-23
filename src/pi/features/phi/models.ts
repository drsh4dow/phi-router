import { Array, Record, pipe } from "effect";
import type { ProviderConfig } from "@earendil-works/pi-coding-agent";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { piWire } from "#shared/pi.ts";

/**
 * Each Anthropic model of the catalog of the pi that loads the package. The provider offers each one with the limits
 * that catalog gives it, and the router routes it as its own target model.
 */
const anthropicCatalog = getBuiltinModels("anthropic");

const free = { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 };

/** A model's id inside the provider `phi`, and the context and output limits pi holds it to. */
interface Limits {
	readonly id: string;
	readonly contextWindow: number;
	readonly maxTokens: number;
}

/**
 * The limits of one of phi's own models: `auto` routes each request, `sealed` pins it. pi has no subagent tool, so the
 * adapter ships none, and `/model phi/sealed` pins every request of the session while it is selected.
 *
 * @param {string} id The model's id inside the provider `phi`.
 * @returns {Limits} Its limits.
 */
const phiOwn = (id: string): Limits => ({ contextWindow: 200_000, id, maxTokens: 32_000 });

/**
 * A model of the provider `phi`.
 *
 * @param {Limits} limits Its id and limits.
 * @returns {object} The model.
 */
const phiModel = ({ contextWindow, id, maxTokens }: Limits): NonNullable<ProviderConfig["models"]>[number] => ({
	compat: { forceAdaptiveThinking: true },
	contextWindow,
	cost: free,
	id,
	input: ["text", "image"],
	maxTokens,
	name: `PHI ${id}`,
	reasoning: true,
});

/** The models of the provider `phi`: its own, then each Anthropic model of pi's catalog. */
const phiModels = pipe(
	Record.keys(piWire.models),
	Array.map(phiOwn),
	Array.appendAll(anthropicCatalog),
	Array.map(phiModel),
);

export { phiModels };
