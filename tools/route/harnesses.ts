import type { AccountMock, Asked, Json, Reply, Said } from "#router/client/mock-upstreams/index.ts";
import { Array, Effect, Option, Record, Schema, String as Str, Stream, Struct, pipe } from "effect";
import {
	judgingOn,
	responseEvents,
	sealingWhen,
	serveAnthropic,
	serveOpenAi,
	textEvents,
} from "#router/client/mock-upstreams/index.ts";
import { HttpClientRequest } from "effect/http";
import type { HttpServer } from "effect/http";
import type { JudgeName } from "#router/client/judge/index.ts";
import type { Scope } from "effect";
import { fakes } from "./fake-credentials.ts";

/** The `anthropic-beta` a test request carries: the subscription login's flag beside one other. */
const beta = "oauth-2025-04-20,fine-grained-tool-streaming-2025-05-14";

/** How one account mock answers a model request. */
type Script = (asked: Asked) => Said;

/** A lane's account: a mock answering by its script, an address where nothing listens, or the test's own server. */
type Lined = Script | "refused" | { readonly endpoint: string };

/**
 * How the mocks of one run answer, and the harness that speaks to the router: Claude Code unless it names another. A lane
 * holds one account answering by `open` or `baa`, unless `opens` or `baas` lists its accounts in order.
 */
interface Scripts {
	readonly harness?: "claude" | "codex" | "pi";
	readonly holdsPhi: (piece: string) => boolean;
	readonly open?: Script;
	readonly baa?: Script;
	readonly opens?: Array.NonEmptyReadonlyArray<Lined>;
	readonly baas?: Array.NonEmptyReadonlyArray<Lined>;
	readonly catalog?: () => Said;
	readonly judge?: (piece: string) => Reply;
	/**
	 * The judge the router picks: Decisions on the judge mock by the file's `judge` block, unless it names `claude`, the
	 * Claude judge on the first BAA account with no `judge` block. Its calls reach the first BAA mock, which answers them
	 * by `holdsPhi`.
	 */
	readonly judgeName?: JudgeName;
	/** What the configuration file lists beside the lanes and the judge, such as `fixtures` or `baaRepos`. */
	readonly configured?: Readonly<Record<string, Json>>;
	/** More of the router's environment, such as a `PATH` that finds stand-in vendor CLIs. */
	readonly env?: Readonly<Record<string, string>>;
	/** The login folder the first open account reads in place of the harness's login. */
	readonly openFolder?: string;
	/** The login folder the first BAA account reads in place of its key. */
	readonly baaFolder?: string;
	/** The models each BAA account lacks, in the lane's order. An account past the list lacks none. */
	readonly lacks?: readonly (readonly string[])[];
}

interface Sent {
	readonly session: string;
	readonly body: string;
}

/**
 * An assistant message as a Responses reply writes it, and as Codex echoes it.
 *
 * @param {object} message Its item id and its text.
 * @returns {Json} The item.
 */
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

/**
 * A Messages request with a URL relative to the router, as Claude Code sends it to `/v1/messages` and the pi package to
 * `/pi/v1/messages`: the session header, a bearer login, `anthropic-version`, `beta`, and `x-not-carried`, a header no
 * account may receive.
 *
 * @param {object} wire Where the harness posts and the header that names its session.
 * @returns {(sent: Sent) => HttpClientRequest.HttpClientRequest} The request of a session id and a body.
 */
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

/**
 * A `/v1/responses` request with a URL relative to the router, as Codex sends it: the headers Codex 0.166.0 sent in the
 * recorded captures, a fake ChatGPT login, and `x-not-carried`, a header no account may receive.
 *
 * @param {Sent} sent The session id and the body.
 * @returns {HttpClientRequest.HttpClientRequest} The request.
 */
const codexRequest = (sent: Sent): HttpClientRequest.HttpClientRequest =>
	HttpClientRequest.post("/v1/responses").pipe(
		HttpClientRequest.setHeaders({
			authorization: `Bearer ${fakes.harnessToken}`,
			"chatgpt-account-id": fakes.accountId,
			originator: "codex_exec",
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

/** Codex's `GET /v1/models`, with the `originator` that names Codex. */
const codexCatalog = HttpClientRequest.get("/v1/models").pipe(HttpClientRequest.setHeader("originator", "codex_exec"));

const jsonOf = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const jsonText = (value: Json): Effect.Effect<string> => Effect.orDie(jsonOf(value));

const headersNamed =
	(names: readonly string[]) =>
	(headers: Readonly<Record<string, string>>): Readonly<Record<string, string>> =>
		pipe(
			headers,
			Record.filter((_value, name) => pipe(names, Array.contains(name))),
		);

/**
 * A `/v1/responses` body in Codex's shape around `input`, with no tools. Codex writes `model` first.
 *
 * @param {readonly Json[]} input The input items.
 * @returns {Effect.Effect<string>} The body.
 */
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

/**
 * A harness the tests drive: its accounts' vendor, the account mock that speaks it, each account's answer `ok`, its
 * request. The open and BAA accounts' answers carry different item ids, as two accounts' replies do.
 */
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

const harnesses: Readonly<Record<NonNullable<Scripts["harness"]>, Harness>> = {
	claude,
	codex: {
		answersOk: {
			baa: () => replying([replyMessage({ id: "msg_baa_ok", text: "ok" })]),
			open: () => replying([replyMessage({ id: "msg_open_ok", text: "ok" })]),
		},
		request: codexRequest,
		serve: (scripts, script) => serveOpenAi({ catalog: scripts.catalog ?? catalog, script }),
		vendor: "openai",
	},
	pi: Struct.assign(claude, { request: messagesRequest({ path: "/pi/v1/messages", sessionHeader: "x-phi-session" }) }),
};

/**
 * What an account's entry in `config.json` adds for the models it lacks.
 *
 * @param {object} of The run's scripts and the account's lane.
 * @returns {Function} `lacks` for the BAA account at an index that `scripts.lacks` lists, else nothing.
 */
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

/**
 * The scripts the BAA lane answers by: with the Claude judge, the first BAA account also answers its calls.
 *
 * @param {object} run The run.
 * @param {Harness} run.harness Its harness.
 * @param {Scripts} run.scripts Its scripts.
 * @returns {Scripts} The BAA lane's scripts.
 */
const baaScriptsOf = ({ harness, scripts }: { readonly harness: Harness; readonly scripts: Scripts }): Scripts => {
	if (scripts.judgeName !== "claude") {
		return scripts;
	}

	return Struct.assign(scripts, {
		baa: judgingOn({ holdsPhi: scripts.holdsPhi, script: scripts.baa ?? harness.answersOk.baa }),
	});
};

export {
	baaScriptsOf,
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
	userMessage,
};

export type { Harness, Lined, Script, Scripts, Sent };

export type { Json } from "#router/client/mock-upstreams/index.ts";

export { credentialBreaches, fakes } from "./fake-credentials.ts";
