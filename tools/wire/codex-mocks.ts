import { Array, Effect, FileSystem, Option, Path, Schema, String as Str, Struct, pipe } from "effect";
import type { Asked, Json, Said } from "#router/client/mock-upstreams/index.ts";
import { handOff, isSubagent, subagent } from "./phi-checks.ts";
import { replyMessage, replying } from "#tools/route/harnesses.ts";
import { roleFile, sealedRole } from "#router/features/cli/index.ts";
import type { Cause } from "effect";
import { fakes } from "#tools/route/mocked-router.ts";

/** The files planted in the working folder: a clean note, and a chart that holds the PHI case's text. */
const files = { chart: "planted-chart.txt", notes: "planted-notes.txt" } as const;

const catting = (call: { readonly file: string; readonly id: string }): Said =>
	replying([
		{
			arguments: `{"cmd":"cat ${call.file}"}`,
			call_id: `call_${call.id}`,
			id: `fc_${call.id}`,
			name: "exec_command",
			status: "completed",
			type: "function_call",
		} satisfies Json,
	]);

/**
 * A call of Codex's multi-agent tools, which start the role `on codex` writes and wait for its answer.
 *
 * @param {object} call The tool's name and its arguments.
 * @returns {Said} The reply that calls it.
 */
const multiAgent = (call: { readonly name: string; readonly arguments: string }): Said =>
	replying([
		{
			arguments: call.arguments,
			call_id: `call_wire_${call.name}`,
			id: `fc_wire_${call.name}`,
			name: call.name,
			namespace: "multi_agent_v1",
			status: "completed",
			type: "function_call",
		} satisfies Json,
	]);

/** The started subagent's id in the output of `spawn_agent`, a JSON string inside the request's JSON. */
const StartedAgent = /\\"agent_id\\":\\"(?<agent>[^\\"]+)\\"/u;

const startedAgent = (asked: Asked): Option.Option<string> =>
	pipe(
		Option.fromNullishOr(StartedAgent.exec(asked.last)),
		Option.flatMap(({ groups }) => Option.fromNullishOr(groups)),
		Option.flatMap((groups) => Option.fromNullishOr(groups["agent"])),
	);

const saying = (text: string): Said => replying([replyMessage({ id: "msg_wire", text })]);

const isToolOutput = (asked: Asked): boolean => Str.includes('"function_call_output"')(asked.last);

/**
 * The open mock: a wait for the pinned subagent once it started, its start when the last item asks for the hand-off,
 * text after a tool result, a call that prints the chart file when the last item names it, and `ok`.
 *
 * @param {Asked} asked What it was asked.
 * @returns {Said} Its answer.
 */
const openScript = (asked: Asked): Said => {
	const agent = startedAgent(asked);

	if (Option.isSome(agent)) {
		return multiAgent({ arguments: `{"targets":["${agent.value}"],"timeout_ms":60000}`, name: "wait_agent" });
	}

	if (Str.includes(handOff)(asked.last)) {
		return multiAgent({
			arguments: `{"agent_type":"phi-sealed","message":"${subagent.prompt}"}`,
			name: "spawn_agent",
		});
	}

	if (isToolOutput(asked)) {
		return saying("The note says the build runs at noon.");
	}

	if (Str.includes(files.chart)(asked.last)) {
		return catting({ file: files.chart, id: "wire_chart" });
	}

	return saying("ok");
};

/**
 * The BAA mock: the pinned subagent's answer, which names the member, to the subagent, text after a tool result, and
 * otherwise a call that prints the clean notes file.
 *
 * @param {Asked} asked What it was asked.
 * @returns {Said} Its answer.
 */
const baaScript = (asked: Asked): Said => {
	if (isSubagent(asked)) {
		return saying(subagent.answer);
	}

	if (isToolOutput(asked)) {
		return saying("Noted.");
	}

	return catting({ file: files.notes, id: "wire_notes" });
};

const Entry = Schema.StructWithRest(Schema.Struct({ slug: Schema.String }), [
	Schema.Record(Schema.String, Schema.Json),
]);

const Catalog = Schema.fromJsonString(Schema.Struct({ models: Schema.Array(Entry) }));

/** The bundled model whose entry the target model copies. Its plain function tools let a mock call `exec_command`. */
const dialect = "gpt-5.5";

/** The slugs of a catalog `codex debug models` printed. */
const listedIn = Effect.fnUntraced(function* listedIn(printed: string) {
	const { models } = yield* Schema.decodeEffect(Catalog)(printed);

	return pipe(
		models,
		Array.map(({ slug }) => slug),
	);
});

/** The open mock's catalog: Codex's bundled one, plus the bundled `dialect` entry renamed to the target model. */
const catalogOf = Effect.fnUntraced(function* catalogOf(bundled: string) {
	const { models } = yield* Schema.decodeEffect(Catalog)(bundled);

	const copied = yield* pipe(
		models,
		Array.findFirst(({ slug }) => slug === dialect),
		Effect.fromOption,
	);

	const served = [...models, Struct.assign(copied, { slug: fakes.targetModel })];
	const body = yield* Schema.encodeEffect(Catalog)({ models: served });

	const slugs = pipe(
		served,
		Array.map(({ slug }) => slug),
	);

	return { body, slugs };
});

/** What the Codex adapter installs in the `CODEX_HOME` `home`: the plugin's hooks, and the role `on codex` writes. */
const installed = Effect.fnUntraced(function* installed(where: { readonly home: string; readonly plugin: string }) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;

	yield* fs.copyFile(path.join(where.plugin, "hooks", "codex.json"), path.join(where.home, "hooks.json"));
	yield* fs.makeDirectory(path.join(where.home, "agents"));
	yield* fs.writeFileString(path.join(where.home, ...roleFile), sealedRole);
});

const SessionLine = /session id: (?<session>\S+)/u;

/**
 * The session id `codex exec` printed.
 *
 * @param {string} printed What it printed on stderr.
 * @returns {Effect.Effect<string, Cause.NoSuchElementError>} The id.
 */
const sessionOf = (printed: string): Effect.Effect<string, Cause.NoSuchElementError> =>
	pipe(
		Option.fromNullishOr(SessionLine.exec(printed)),
		Option.flatMap(({ groups }) => Option.fromNullishOr(groups)),
		Option.flatMap(({ session }) => Option.fromNullishOr(session)),
		Effect.fromOption,
	);

export { baaScript, catalogOf, files, installed, listedIn, openScript, sessionOf };
