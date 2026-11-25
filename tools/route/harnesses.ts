import type { AccountMock, Asked, Json, Reply, Said } from "#router/client/mock-upstreams/index.ts";
import { Array, Effect, FileSystem, Option, Record, Schema, String as Str, Stream, Struct, pipe } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import {
	responseEvents,
	sealingWhen,
	serveAnthropic,
	serveOpenAi,
	textEvents,
} from "#router/client/mock-upstreams/index.ts";
import { HttpClientRequest } from "effect/http";
import type { HttpServer } from "effect/http";
import type { Scope } from "effect";
import { fakes } from "./fake-credentials.ts";

const subscriptionLoginBeta = "oauth-2025-04-20";

const toolStreamingBeta = "fine-grained-tool-streaming-2025-05-14";

const beta = `${subscriptionLoginBeta},${toolStreamingBeta}`;

type AccountScript = (asked: Asked) => Said;

interface OwnServer {
	readonly endpoint: string;
}

type LaneAccount = AccountScript | "refused" | OwnServer;

interface Scripts {
	readonly harness?: "claude" | "codex" | "pi";
	readonly holdsPhi: (piece: string) => boolean;
	readonly open?: AccountScript;
	readonly baa?: AccountScript;
	readonly opens?: Array.NonEmptyReadonlyArray<LaneAccount>;
	readonly baas?: Array.NonEmptyReadonlyArray<LaneAccount>;
	readonly catalog?: () => Said;
	readonly judge?: (piece: string) => Reply;
	readonly configExtras?: Readonly<Record<string, Json>>;
	readonly routerEnv?: Readonly<Record<string, string>>;
	readonly openFolder?: string;
	readonly baaFolder?: string;
	readonly lacks?: readonly (readonly string[])[];
}

interface Sent {
	readonly session: string;
	readonly body: string;
}

const replyMessage = (message: { readonly id: string; readonly text: string }): Json => ({
	content: [{ annotations: [], logprobs: [], text: message.text, type: "output_text" }],
	id: message.id,
	role: "assistant",
	status: "completed",
	type: "message",
});

const userMessage = (text: string): Json => ({
	content: [{ text, type: "input_text" }],
	role: "user",
	type: "message",
});

const replying = (items: readonly Json[]): Said => ({
	events: Stream.fromIterable(responseEvents(items)),
	kind: "events",
});

const ok = 200;

const catalog = (): Said => ({
	body: `{"models":[{"slug":"other-model","visibility":"list"},{"context_window":272000,"display_name":"Target","slug":"${fakes.targetModel}","upgrade":"newer-model","visibility":"hide"}]}`,
	kind: "status",
	status: ok,
});

const messagesRequest =
	(wire: { readonly path: string; readonly sessionHeader: string }) =>
	(sent: Sent): HttpClientRequest.HttpClientRequest =>
		HttpClientRequest.post(wire.path).pipe(
			HttpClientRequest.setHeaders({
				"anthropic-beta": beta,
				"anthropic-version": "2023-06-01",
				authorization: `Bearer ${fakes.harnessToken}`,
				[wire.sessionHeader]: sent.session,
				"x-not-carried": "1",
			}),
			HttpClientRequest.bodyText(sent.body, "application/json"),
		);

const claudeRequest = messagesRequest({ path: "/v1/messages?beta=true", sessionHeader: "x-claude-code-session-id" });

const codexOriginator = "codex_exec";

const codexRequest = (sent: Sent): HttpClientRequest.HttpClientRequest =>
	HttpClientRequest.post("/v1/responses").pipe(
		HttpClientRequest.setHeaders({
			authorization: `Bearer ${fakes.harnessToken}`,
			"chatgpt-account-id": fakes.accountId,
			originator: codexOriginator,
			"session-id": sent.session,
			"thread-id": "thread-1",
			"user-agent": "codex_exec/0.166.0",
			"x-client-request-id": sent.session,
			"x-codex-turn-metadata": "{}",
			"x-not-carried": "1",
			"x-openai-internal-codex-responses-lite": "true",
		}),
		HttpClientRequest.bodyText(sent.body, "application/json"),
	);

const codexCatalog = HttpClientRequest.get("/v1/models").pipe(
	HttpClientRequest.setHeader("originator", codexOriginator),
);

const jsonOf = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const jsonText = (value: Json): Effect.Effect<string> => Effect.orDie(jsonOf(value));

const headersNamed =
	(names: readonly string[]) =>
	(headers: Readonly<Record<string, string>>): Readonly<Record<string, string>> =>
		pipe(
			headers,
			Record.filter((_value, name) => pipe(names, Array.contains(name))),
		);

const codexBodyOf = (input: readonly Json[]): Effect.Effect<string> =>
	Effect.map(
		jsonText({
			include: ["reasoning.encrypted_content"],
			input,
			parallel_tool_calls: false,
			reasoning: { summary: "auto" },
			store: false,
			stream: true,
			tool_choice: "auto",
		}),
		Str.replace(/^\{/u, '{"model":"phi/auto",'),
	);

const HookCommand = Schema.Struct({ command: Schema.String });

const SessionStart = Schema.Array(Schema.Struct({ hooks: Schema.Array(HookCommand) }));

const SessionStartHooks = Schema.fromJsonString(Schema.Struct({ hooks: Schema.Struct({ SessionStart }) }));

const sessionStartHooksRan = Effect.fnUntraced(function* sessionStartHooksRan(run: {
	readonly file: string;
	readonly env: Readonly<Record<string, string>>;
	readonly input: string;
}) {
	const fs = yield* FileSystem.FileSystem;
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const { hooks } = yield* fs.readFileString(run.file).pipe(Effect.flatMap(Schema.decodeEffect(SessionStartHooks)));
	const stdin = Stream.encodeText(Stream.make(run.input));

	const commands = pipe(
		hooks.SessionStart,
		Array.flatMap((matcher) => matcher.hooks),
		Array.map(({ command }) => ChildProcess.make("sh", ["-c", command], { env: run.env, extendEnv: true, stdin })),
	);

	yield* Effect.forEach(commands, (command) => Effect.flatMap(spawner.spawn(command), (hook) => hook.exitCode), {
		concurrency: 1,
		discard: true,
	});
}, Effect.scoped);

interface Harness {
	readonly vendor: "anthropic" | "openai";
	readonly answersOk: Readonly<Record<"open" | "baa", () => Said>>;
	readonly serve: (
		scripts: Scripts,
		script: (asked: Asked) => Said,
	) => Effect.Effect<AccountMock, never, HttpServer.HttpServer | Scope.Scope>;
	readonly request: (sent: Sent) => HttpClientRequest.HttpClientRequest;
}

const claude: Harness = {
	answersOk: {
		baa: () => ({ events: Stream.fromIterable(textEvents(["ok"])), kind: "events" }),
		open: () => ({ events: Stream.fromIterable(textEvents(["ok"])), kind: "events" }),
	},
	request: claudeRequest,
	serve: (_scripts, script) => serveAnthropic(script),
	vendor: "anthropic",
};

const codexAnswerOk = (lane: "open" | "baa") => (): Said =>
	replying([replyMessage({ id: `msg_${lane}_ok`, text: "ok" })]);

const harnesses: Readonly<Record<NonNullable<Scripts["harness"]>, Harness>> = {
	claude,
	codex: {
		answersOk: { baa: codexAnswerOk("baa"), open: codexAnswerOk("open") },
		request: codexRequest,
		serve: (scripts, script) => serveOpenAi({ catalog: scripts.catalog ?? catalog, script }),
		vendor: "openai",
	},
	pi: Struct.assign(claude, { request: messagesRequest({ path: "/pi/v1/messages", sessionHeader: "x-phi-session" }) }),
};

const lacksOf =
	(of: { readonly scripts: Scripts; readonly lane: "open" | "baa" }) =>
	(index: number): Readonly<Record<string, Json>> =>
		pipe(
			Option.fromUndefinedOr(of.scripts.lacks),
			Option.flatMapNullishOr((each) => each[index]),
			Option.filter(() => of.lane === "baa"),
			Option.match({ onNone: () => ({}), onSome: (lacks) => ({ lacks }) }),
		);

const judgeOf = (scripts: Scripts): ((piece: string) => Reply) => scripts.judge ?? sealingWhen(scripts.holdsPhi);

export {
	beta,
	claudeRequest,
	codexBodyOf,
	codexCatalog,
	codexRequest,
	harnesses,
	headersNamed,
	jsonText,
	judgeOf,
	lacksOf,
	replyMessage,
	replying,
	sessionStartHooksRan,
	userMessage,
};

export type { AccountScript, Harness, LaneAccount, Scripts, Sent };

export type { Json } from "#router/client/mock-upstreams/index.ts";

export { credentialBreaches, fakes } from "./fake-credentials.ts";
