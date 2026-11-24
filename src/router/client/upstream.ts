import type { Account, Accounts, Answered, Headers, OpenAiAccounts, Unanswered } from "./upstream-accounts.ts";
import { Array, Effect, Option, Record, Redacted, String as Str, Stream, Struct, pipe } from "effect";
import type { Credential, NamedAccount, Vendor, VendorLanes } from "./lane-configuration.ts";
import { HttpClient, HttpClientRequest } from "effect/http";
import { folderLogin, readKey } from "./credentials.ts";
import { Refused } from "./upstream-refused.ts";
import { Rejected } from "./upstream-rejected.ts";
import type { Scope } from "effect";
import { laneConfiguration } from "./lane-configuration.ts";

const wires = {
	anthropic: {
		copied: {
			forwarded: ["anthropic-beta", "anthropic-version", "user-agent", "x-app", "authorization", "x-api-key"],
			key: ["anthropic-beta", "anthropic-version", "user-agent", "x-app"],
			loginFolder: ["anthropic-beta", "anthropic-version", "user-agent", "x-app"],
		},
		returned: ["content-type", "request-id", "retry-after", "x-should-retry"],
		send: "/v1/messages?beta=true",
	},
	openai: {
		catalog: { path: "/models", query: ["client_version"] },
		copied: {
			forwarded: [
				"authorization",
				"chatgpt-account-id",
				"originator",
				"user-agent",
				"session-id",
				"x-openai-internal-codex-responses-lite",
			],
			key: [],
			loginFolder: ["originator", "user-agent", "session-id", "x-openai-internal-codex-responses-lite"],
		},
		returned: ["content-type", "x-request-id", "retry-after"],
		send: "/responses",
	},
} as const satisfies Record<
	Vendor,
	{
		readonly copied: Record<Credential["kind"], readonly string[]>;
		readonly returned: readonly string[];
		readonly send: string;
		readonly catalog?: { readonly path: string; readonly query: readonly string[] };
	}
>;

const oauthBeta = "oauth-2025-04-20";

const picked = (headers: Headers, names: readonly string[]): Record<string, string> =>
	Record.fromEntries(
		pipe(
			names,
			Array.flatMap((name) =>
				pipe(
					Option.fromNullishOr(headers[name]),
					Option.map((value) => [name, value] as const),
					Option.toArray,
				),
			),
		),
	);

/**
 * The copied headers with `anthropic-beta` stripped of the subscription login's flag, which an API key does not take.
 *
 * @param {Headers} headers The harness's headers.
 * @returns {Record<string, string>} The headers to send.
 */
const withoutOauth = (headers: Headers): Record<string, string> => {
	const kept = pipe(
		Option.fromNullishOr(headers["anthropic-beta"]),
		Option.map((beta) =>
			pipe(
				beta,
				Str.split(","),
				Array.map(Str.trim),
				Array.filter((flag) => flag !== oauthBeta),
				Array.join(","),
			),
		),
		Option.filter(Str.isNonEmpty),
	);

	return Struct.assign(picked(headers, wires.anthropic.copied.key), { "anthropic-beta": Option.getOrUndefined(kept) });
};

/**
 * The headers a forwarded or keyed account receives: the copied ones and exactly one credential. A forwarded account
 * takes the harness's own. A keyed account never sees the harness's, and its key is read once, here.
 */
const headersFor = Effect.fnUntraced(function* headersFor(
	vendor: Vendor,
	credential: Exclude<Credential, { readonly kind: "loginFolder" }>,
) {
	const { copied } = wires[vendor];

	if (credential.kind === "forwarded") {
		return (harness: Headers): Headers => picked(harness, copied.forwarded);
	}

	const redacted = yield* readKey(credential.source);
	const key = Redacted.value(redacted);

	if (vendor === "anthropic" && credential.scheme === "apiKey") {
		return (harness: Headers): Headers => Struct.assign(withoutOauth(harness), { "x-api-key": key });
	}

	return (harness: Headers): Headers => Struct.assign(picked(harness, copied.key), { authorization: `Bearer ${key}` });
});

/** A request the caller builds on an account's endpoint. */
type To = (endpoint: string) => HttpClientRequest.HttpClientRequest;

/**
 * The one way out to an account: the request `to` builds on its endpoint, with `headers`, no redirect followed and no
 * trace header.
 */
type Caller = (call: { readonly headers: Headers; readonly to: To }) => Effect.Effect<Answered, Refused, Scope.Scope>;

const callerOf = Effect.fnUntraced(function* callerOf(named: NamedAccount) {
	const client = yield* HttpClient.HttpClient;
	const http = HttpClient.withScope(client);
	const refused = (): Refused => Refused.make({ account: named.name });
	const { returned } = wires[named.vendor];

	const call: Caller = ({ headers, to }) => {
		const sent = pipe(headers, Record.map(Option.fromNullishOr), Record.getSomes);

		return to(named.endpoint).pipe(
			HttpClientRequest.setHeaders(sent),
			http.execute,
			Effect.mapBoth({
				onFailure: refused,
				onSuccess: (response) => ({
					body: Stream.mapError(response.stream, refused),
					headers: picked(response.headers, returned),
					status: response.status,
				}),
			}),
		);
	};

	return call;
});

const unauthorized = 401;

/** One request to one account with the harness's `headers`, its credential added. */
type Ask = (harness: Headers, to: To) => Effect.Effect<Answered, Unanswered, Scope.Scope>;

interface Asking {
	readonly ask: Ask;
	readonly ready: Account["ready"];
}

/**
 * How one account is asked. A login folder is read before each request, and its account receives the copied headers,
 * never the harness's credential, and the token read for this send. A Codex home folder adds its ChatGPT account. On a
 * 401 the folder's token is marked rejected and the ask fails with `Rejected`. Any other answer of any account passes
 * as it came.
 */
const askingOf = Effect.fnUntraced(function* askingOf(named: NamedAccount) {
	const call = yield* callerOf(named);
	const { credential, name, vendor } = named;

	if (credential.kind !== "loginFolder") {
		const headersOf = yield* headersFor(vendor, credential);

		const keyed: Asking = {
			ask: (harness, to) => call({ headers: headersOf(harness), to }),
			ready: () => Effect.void,
		};

		return keyed;
	}

	const login = yield* folderLogin({ folder: credential.folder, name, vendor });

	const ask: Ask = (harness, to) =>
		Effect.gen(function* asked() {
			const held = yield* login.current;

			const headers = Struct.assign(picked(harness, wires[vendor].copied.loginFolder), {
				authorization: `Bearer ${Redacted.value(held.login.token)}`,
				"chatgpt-account-id": Option.getOrUndefined(held.login.chatgptAccount),
			});

			const answer = yield* call({ headers, to });

			if (answer.status !== unauthorized) {
				return answer;
			}

			yield* held.rejected;

			return yield* Rejected.make({ account: name });
		});

	const folder: Asking = { ask, ready: () => login.ready };

	return folder;
});

const accountOf = (named: NamedAccount, { ask, ready }: Asking): Account => ({
	lacks: named.lacks,
	name: named.name,
	ready,
	send: ({ headers, body }) =>
		ask(headers, (endpoint) =>
			HttpClientRequest.post(`${endpoint}${wires[named.vendor].send}`).pipe(
				HttpClientRequest.bodyText(body, "application/json"),
			),
		),
});

/** A lane's accounts in the file's order, and how its first account is asked. */
const laneOf = Effect.fnUntraced(function* laneOf([first, ...rest]: Array.NonEmptyReadonlyArray<NamedAccount>) {
	const firstAsking = yield* askingOf(first);

	const others = yield* Effect.forEach(
		rest,
		(named) => Effect.map(askingOf(named), (asking) => accountOf(named, asking)),
		{ concurrency: 1 },
	);

	return { accounts: Array.prepend(others, accountOf(first, firstAsking)), firstAsking };
});

const accountsOf = Effect.fnUntraced(function* accountsOf({ clean, sealed, sealedModel, targetModel }: VendorLanes) {
	const open = yield* laneOf(clean);
	const baa = yield* laneOf(sealed);
	const { path, query: names } = wires.openai.catalog;

	const catalog: OpenAiAccounts["catalog"] = ({ headers, query }) =>
		Effect.andThen(
			open.firstAsking.ready(),
			open.firstAsking.ask(headers, (endpoint) =>
				HttpClientRequest.get(`${endpoint}${path}`, { urlParams: picked(query, names) }),
			),
		);

	return { catalog, clean: open.accounts, sealed: baa.accounts, sealedModel, targetModel };
});

/**
 * The accounts behind the two lanes, per vendor the configuration names, each lane a list in the file's order. Only
 * OpenAI's carry a model catalog, the one Codex reads.
 */
interface Served {
	readonly anthropic: Option.Option<Accounts>;
	readonly openai: Option.Option<OpenAiAccounts>;
}

/** The accounts a `config.json` text names, each key read from its source. */
const servedBy = Effect.fnUntraced(function* servedBy(text: string) {
	const lanes = yield* laneConfiguration(text);
	const anthropic = yield* Effect.transposeOption(pipe(lanes.anthropic, Option.map(accountsOf)));
	const openai = yield* Effect.transposeOption(pipe(lanes.openai, Option.map(accountsOf)));

	return {
		anthropic: pipe(
			anthropic,
			Option.map((accounts): Accounts => Struct.omit(accounts, ["catalog"])),
		),
		openai,
	} satisfies Served;
});

export { askingOf, servedBy };

export type { Served };
