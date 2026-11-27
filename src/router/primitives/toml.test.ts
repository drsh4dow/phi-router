import { Array, Effect, String as Str, pipe } from "effect";
import { assert, it } from "@effect/vitest";
import { statementsOf } from "./toml.ts";

const file = `# Codex settings
model = "gpt-6-sol" # the default
features.goals = true

[ model_providers . "phi" ]
base_url = 'http://127.0.0.1:1/v1'
args = [
  "a", # one
  "]",
]

[[skills]]
"odd=key".name = { x = 1 }
notes = """
[model_providers.phi]
"""
[plugins."p@m"]
enabled = true`;

const seen = pipe(
	statementsOf(file),
	Array.map(({ end, kind, path, start, value }) => ({ kind, path, text: Str.slice(start, end)(file), value })),
);

it.effect("reads a file with CRLF line ends as the same statements, each keeping its own line ends", () =>
	Effect.sync(() => {
		const crlfOf = Str.replaceAll("\n", "\r\n");
		const crlf = crlfOf(file);

		const read = pipe(
			statementsOf(crlf),
			Array.map(({ end, kind, path, start, value }) => ({ kind, path, text: Str.slice(start, end)(crlf), value })),
		);

		assert.deepStrictEqual(
			read,
			pipe(
				seen,
				Array.map(({ kind, path, text, value }) => ({ kind, path, text: crlfOf(text), value: crlfOf(value) })),
			),
		);
	}),
);

it.effect("reads each statement's kind, full key, value and lines, past comments, strings and brackets", () =>
	Effect.sync(() => {
		assert.deepStrictEqual(seen, [
			{ kind: "pair", path: ["model"], text: 'model = "gpt-6-sol" # the default\n', value: '"gpt-6-sol"' },
			{ kind: "pair", path: ["features", "goals"], text: "features.goals = true\n", value: "true" },
			{ kind: "table", path: ["model_providers", "phi"], text: '[ model_providers . "phi" ]\n', value: "" },
			{
				kind: "pair",
				path: ["model_providers", "phi", "base_url"],
				text: "base_url = 'http://127.0.0.1:1/v1'\n",
				value: "'http://127.0.0.1:1/v1'",
			},
			{
				kind: "pair",
				path: ["model_providers", "phi", "args"],
				text: 'args = [\n  "a", # one\n  "]",\n]\n',
				value: '[\n  "a", \n  "]",\n]',
			},
			{ kind: "arrayOfTables", path: ["skills"], text: "[[skills]]\n", value: "" },
			{
				kind: "pair",
				path: ["skills", "odd=key", "name"],
				text: '"odd=key".name = { x = 1 }\n',
				value: "{ x = 1 }",
			},
			{
				kind: "pair",
				path: ["skills", "notes"],
				text: 'notes = """\n[model_providers.phi]\n"""\n',
				value: '"""\n[model_providers.phi]\n"""',
			},
			{ kind: "table", path: ["plugins", "p@m"], text: '[plugins."p@m"]\n', value: "" },
			{ kind: "pair", path: ["plugins", "p@m", "enabled"], text: "enabled = true", value: "true" },
		]);
	}),
);
