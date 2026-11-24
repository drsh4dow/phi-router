import { Array, Option, Record, pipe } from "effect";
import type { ModelsJson } from "#shared/cli.ts";
import type { ProviderConfig } from "@earendil-works/pi-coding-agent";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { piWire } from "#shared/pi.ts";

const anthropicCatalog = getBuiltinModels("anthropic");

const free = { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 };

interface PhiModelLimits {
	readonly id: string;
	readonly contextWindow: number;
	readonly maxTokens: number;
}

const phiOwn =
	(models: typeof ModelsJson.Type) =>
	(id: keyof typeof piWire.models): PhiModelLimits =>
		pipe(
			Option.fromUndefinedOr(models.anthropic),
			Option.flatMap((routed) => Array.findFirst(anthropicCatalog, (model) => model.id === routed[id])),
			Option.match({
				onNone: () => ({ contextWindow: 200_000, id, maxTokens: 32_000 }),
				onSome: ({ contextWindow, maxTokens }) => ({ contextWindow, id, maxTokens }),
			}),
		);

const phiModel = ({ contextWindow, id, maxTokens }: PhiModelLimits): NonNullable<ProviderConfig["models"]>[number] => ({
	compat: { forceAdaptiveThinking: true },
	contextWindow,
	cost: free,
	id,
	input: ["text", "image"],
	maxTokens,
	name: `PHI ${id}`,
	reasoning: true,
});

const phiModels = (models: typeof ModelsJson.Type): NonNullable<ProviderConfig["models"]> =>
	pipe(Record.keys(piWire.models), Array.map(phiOwn(models)), Array.appendAll(anthropicCatalog), Array.map(phiModel));

export { phiModels };
