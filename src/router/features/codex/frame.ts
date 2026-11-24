import { Array, Option, pipe } from "effect";
import type { Body, Raw } from "./wire.ts";
import type { InputEntry } from "./groups.ts";

const namesIn = (entry: InputEntry): readonly string[] => {
	if (entry.kind === "unread") {
		return [];
	}

	const { item } = entry;

	switch (item.type) {
		case "function_call": {
			return [item.name, ...Option.toArray(Option.fromUndefinedOr(item.namespace))];
		}

		case "custom_tool_call": {
			return [item.name];
		}

		case "agent_message": {
			return [item.author, item.recipient];
		}

		case "additional_tools":
		case "message":
		case "reasoning":
		case "function_call_output":
		case "custom_tool_call_output": {
			return [];
		}

		default: {
			const unhandled: never = item;

			return unhandled;
		}
	}
};

interface Lists {
	readonly frame: readonly (readonly (typeof Raw.Type)[])[];
	readonly tools: readonly (typeof Raw.Type)[];
}

const agentOf = (metadata: NonNullable<(typeof Body.Type)["client_metadata"]>): readonly string[] =>
	pipe(
		Option.fromUndefinedOr(metadata["x-codex-turn-metadata"]),
		Option.flatMap(({ agent_name: agentName }) => Option.fromUndefinedOr(agentName)),
		Option.toArray,
	);

const frameOf = ({
	body: { client_metadata: metadata = {}, text: { format } = { verbosity: "" }, tools = [] },
	entries,
}: {
	readonly body: typeof Body.Type;
	readonly entries: readonly InputEntry[];
}): Lists => {
	const subagent = Option.toArray(Option.fromUndefinedOr(metadata["x-openai-subagent"]));
	const itemNames = pipe(entries, Array.flatMap(namesIn));
	const names = Array.dedupe([...itemNames, ...agentOf(metadata), ...subagent]);

	const named: readonly (typeof Raw.Type)[] = Array.match(names, {
		onEmpty: () => [],
		onNonEmpty: (list) => [{ names: list, type: "names" }],
	});

	return { frame: [Option.toArray(Option.fromUndefinedOr(format)), named], tools };
};

export { frameOf };

export type { Lists };
