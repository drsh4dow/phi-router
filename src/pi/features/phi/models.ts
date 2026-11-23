import { Array, Option, Record, pipe } from "effect";
import type { ModelsJson } from "#shared/cli.ts";
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
 * adapter ships none, and `/model phi/sealed` pins every request of the session while it is selected. Each gets the
 * limits pi's catalog gives the model it runs, or 200K and 32K when the catalog lacks that model or none is known.
 *
 * @param {ModelsJson} models The models `config.json` names for each vendor.
 * @returns {Function} The limits of the model with an id of `piWire.models`.
 */
const phiOwn =
	(models: typeof ModelsJson.Type) =>
	(id: keyof typeof piWire.models): Limits =>
		pipe(
			Option.fromUndefinedOr(models.anthropic),
			Option.flatMap((routed) => Array.findFirst(anthropicCatalog, (model) => model.id === routed[id])),
			Option.match({
				onNone: () => ({ contextWindow: 200_000, id, maxTokens: 32_000 }),
				onSome: ({ contextWindow, maxTokens }) => ({ contextWindow, id, maxTokens }),
			}),
		);

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

/**
 * The models of the provider `phi`: its own, then each Anthropic model of pi's catalog.
 *
 * @param {ModelsJson} models The models `config.json` names for each vendor.
 * @returns {object[]} The models.
 */
const phiModels = (models: typeof ModelsJson.Type): NonNullable<ProviderConfig["models"]> =>
	pipe(Record.keys(piWire.models), Array.map(phiOwn(models)), Array.appendAll(anthropicCatalog), Array.map(phiModel));

export { phiModels };
