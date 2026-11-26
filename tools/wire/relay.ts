import {
	Array,
	Context,
	Effect,
	FileSystem,
	Layer,
	Option,
	Path,
	Record,
	Ref,
	Schema,
	String as Str,
	Stream,
	Struct,
	pipe,
} from "effect";
import {
	HttpClient,
	HttpClientRequest,
	HttpMethod,
	HttpServer,
	HttpServerRequest,
	HttpServerResponse,
} from "effect/http";
import { NodeHttpServer } from "@effect/platform-node";
import type { Usage } from "./spent.ts";
import type { VendorLanes } from "#router/client/configuration/index.ts";
import { laneConfiguration } from "#router/client/configuration/index.ts";
import { usageIn } from "./spent.ts";
import { writePrivately } from "#router/client/private-file.ts";

type Lane = "open" | "baa";

interface Upstream {
	readonly account: string;
	readonly lane: Lane;
	readonly endpoint: string;
}

interface Relayed {
	readonly account: string;
	readonly lane: Lane;
	readonly model: string;
	readonly status: number;
	readonly holdsCanary: boolean;
	readonly usage: Usage;
}

interface Relay {
	readonly canaries: readonly string[];
	readonly record: (relayed: Relayed) => Effect.Effect<void>;
}

const notForwarded = ["accept-encoding", "connection", "content-length", "host", "transfer-encoding"];

const decodedByFetch = ["connection", "content-encoding", "content-length", "transfer-encoding"];

const without =
	(names: readonly string[]) =>
	(headers: Readonly<Record<string, string>>): Record<string, string> =>
		pipe(
			headers,
			Record.filter((_value, name) => !pipe(names, Array.contains(name))),
		);

const decodeModel = Schema.decodeOption(Schema.fromJsonString(Schema.Struct({ model: Schema.String })));

const modelOf = (body: string): string =>
	Option.match(decodeModel(body), { onNone: () => "", onSome: ({ model }) => model });

const requestOf = Effect.fnUntraced(function* requestOf(endpoint: string) {
	const request = yield* HttpServerRequest.HttpServerRequest;
	const body = yield* request.text;
	const method = yield* Effect.fromOption(Option.liftPredicate(request.method, HttpMethod.isHttpMethod));

	const outgoing = pipe(
		HttpClientRequest.make(method)(`${endpoint}${request.url}`),
		HttpClientRequest.setHeaders(without(notForwarded)(request.headers)),
	);

	if (Str.isEmpty(body)) {
		return { body, outgoing };
	}

	return { body, outgoing: HttpClientRequest.bodyText(outgoing, body) };
});

const relayed = Effect.fnUntraced(function* relayed(upstream: Upstream, relay: Relay) {
	const client = yield* HttpClient.HttpClient;
	const { body, outgoing } = yield* requestOf(upstream.endpoint);
	const response = yield* HttpClient.withScope(client).execute(outgoing);
	const answer = yield* Ref.make("");
	const decoder = new TextDecoder();

	const recorded = Effect.gen(function* recorded() {
		const text = yield* Ref.get(answer);

		const record: Relayed = {
			account: upstream.account,
			holdsCanary: pipe(
				relay.canaries,
				Array.some((canary) => Str.includes(canary)(body)),
			),
			lane: upstream.lane,
			model: modelOf(body),
			status: response.status,
			usage: usageIn(text),
		};

		yield* relay.record(record);
	});

	const streamed = response.stream.pipe(
		Stream.tap((chunk) => Ref.update(answer, (text) => text + decoder.decode(chunk, { stream: true }))),
		Stream.ensuring(recorded),
	);

	return HttpServerResponse.stream(streamed, {
		headers: without(decodedByFetch)(response.headers),
		status: response.status,
	});
});

const relayTo = Effect.fnUntraced(function* relayTo(upstream: Upstream, relay: Relay) {
	const client = yield* HttpClient.HttpClient;
	const built = yield* Layer.build(NodeHttpServer.layerTest);
	const server = Context.get(built, HttpServer.HttpServer);

	const answered = Effect.provideService(relayed(upstream, relay), HttpClient.HttpClient, client);

	yield* server.serve(Effect.orDie(answered));

	return HttpServer.formatAddress(server.address);
});

const Rest = Schema.Record(Schema.String, Schema.Unknown);

const RawAccount = Schema.StructWithRest(Schema.Struct({ name: Schema.String }), [Rest]);

type Account = typeof RawAccount.Type;

const Lanes = Schema.Struct({ clean: Schema.Array(RawAccount), sealed: Schema.Array(RawAccount) });

const RawConfig = Schema.fromJsonString(Schema.StructWithRest(Lanes, [Rest]));

const upstreamsOf = (lanes: readonly VendorLanes[]): readonly Upstream[] =>
	pipe(
		lanes,
		Array.flatMap(({ clean, sealed }) => [
			...pipe(
				clean,
				Array.map(({ endpoint, name }): Upstream => ({ account: name, endpoint, lane: "open" })),
			),
			...pipe(
				sealed,
				Array.map(({ endpoint, name }): Upstream => ({ account: name, endpoint, lane: "baa" })),
			),
		]),
	);

const relayedConfig = Effect.fnUntraced(function* relayedConfig(configHome: string, canaries: readonly string[]) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const text = yield* fs.readFileString(path.join(configHome, "phi-router", "config.json"));
	const records = yield* Ref.make<readonly Relayed[]>([]);
	const lanes = yield* laneConfiguration(text);
	const upstreams = upstreamsOf(Array.getSomes(Record.values(lanes)));
	const relay: Relay = { canaries, record: (one) => Ref.update(records, Array.append(one)) };

	const relays = yield* Effect.forEach(
		upstreams,
		(upstream) => Effect.map(relayTo(upstream, relay), (url) => [upstream.account, url] as const),
		{ concurrency: 1 },
	);

	const relayOf = Record.fromEntries(relays);
	const raw = yield* Schema.decodeEffect(RawConfig)(text);

	const pointed = (account: Account): Account =>
		Option.match(Record.get(relayOf, account.name), {
			onNone: () => account,
			onSome: (endpoint): Account => Struct.assign(account, { endpoint, name: account.name }),
		});

	const lanesPointed = { clean: pipe(raw.clean, Array.map(pointed)), sealed: pipe(raw.sealed, Array.map(pointed)) };
	const rewritten = yield* Schema.encodeEffect(RawConfig)(Struct.assign(raw, lanesPointed));
	const folder = yield* fs.makeTempDirectoryScoped({ prefix: "phi-accounts-config-" });

	yield* writePrivately(path.join(folder, "phi-router", "config.json"), rewritten);

	return { configHome: folder, relayed: Ref.get(records) };
});

export { relayedConfig };

export type { Relayed };
