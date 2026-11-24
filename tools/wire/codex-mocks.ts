import { Array, Effect, FileSystem, Option, Path, Schema, String as Str, Struct, pipe } from "effect";
import type { Asked, Json, Said } from "#router/client/mock-upstreams/index.ts";
import { handOff, isSubagent, subagent } from "./phi-checks.ts";
import { pinnedRoleFile, sealedRole } from "#router/features/cli/index.ts";
import { replyMessage, replying } from "#tools/route/harnesses.ts";
import type { Cause } from "effect";
import { fakes } from "#tools/route/mocked-router.ts";

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

const StartedAgent = /\\"agent_id\\":\\"(?<agent>[^\\"]+)\\"/u;

const startedAgent = (asked: Asked): Option.Option<string> =>
	pipe(
		Option.fromNullishOr(StartedAgent.exec(asked.last)),
		Option.flatMap(({ groups }) => Option.fromNullishOr(groups)),
		Option.flatMap((groups) => Option.fromNullishOr(groups["agent"])),
	);

const saying = (text: string): Said => replying([replyMessage({ id: "msg_wire", text })]);

const isToolOutput = (asked: Asked): boolean => Str.includes('"function_call_output"')(asked.last);

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

const dialect = "gpt-5.5";

const catalogSlugsOf = Effect.fnUntraced(function* catalogSlugsOf(catalog: string) {
	const { models } = yield* Schema.decodeEffect(Catalog)(catalog);

	return pipe(
		models,
		Array.map(({ slug }) => slug),
	);
});

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

const installed = Effect.fnUntraced(function* installed(where: { readonly home: string; readonly plugin: string }) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;

	yield* fs.copyFile(path.join(where.plugin, "hooks", "codex.json"), path.join(where.home, "hooks.json"));
	yield* fs.makeDirectory(path.join(where.home, "agents"));
	yield* fs.writeFileString(path.join(where.home, ...pinnedRoleFile), sealedRole);
});

const SessionLine = /session id: (?<session>\S+)/u;

const execSessionOf = (stderr: string): Effect.Effect<string, Cause.NoSuchElementError> =>
	pipe(
		Option.fromNullishOr(SessionLine.exec(stderr)),
		Option.flatMap(({ groups }) => Option.fromNullishOr(groups)),
		Option.flatMap(({ session }) => Option.fromNullishOr(session)),
		Effect.fromOption,
	);

export { baaScript, catalogOf, catalogSlugsOf, execSessionOf, files, installed, openScript };
