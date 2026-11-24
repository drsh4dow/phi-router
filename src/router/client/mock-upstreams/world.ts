import { Array, ConfigProvider, Effect, FileSystem, Formatter, Layer, Stream, Struct } from "effect";
import { responseEvents, serveAnthropic, serveOpenAi, textEvents } from "./accounts.ts";
import { sealingWhen, serveJudge } from "./judge.ts";
import { Listener } from "#router/client/router-port/index.ts";
import type { Said } from "./accounts.ts";
import { UserDirectories } from "effect/persistence";
import { configFile } from "#router/client/configuration/index.ts";
import { writePrivately } from "#router/client/private-file.ts";

/** The request bodies the open and the BAA mock received. Bodies only, so no header, and no login, leaves this file. */
interface Arrived {
	readonly open: readonly string[];
	readonly baa: readonly string[];
}

/** The fake keys the world's `config.json` names. No real account ever sees them. */
const fakeKeys = { PHI_DOCTOR_BAA_KEY: "phi-doctor-baa-key", PHI_DOCTOR_JUDGE_KEY: "phi-doctor-judge-key" };

const anyFreePort = 0;

/** The vendor whose API the world's two accounts speak. */
type Vendor = "anthropic" | "openai";

/** The model the router sends a sealed request to, which the OpenAI mocks' catalog lists. */
const targetModel = "phi-doctor-target";

const ok = 200;

const okMessage = {
	content: [{ annotations: [], text: "ok", type: "output_text" }],
	id: "msg_doctor_ok",
	role: "assistant",
	status: "completed",
	type: "message",
};

/** Each vendor's account mock, which answers every model request `ok`. */
const accounts = {
	anthropic: serveAnthropic((): Said => ({ events: Stream.fromIterable(textEvents(["ok"])), kind: "events" })),
	openai: serveOpenAi({
		catalog: (): Said => ({
			body: Formatter.formatJson({ models: [{ display_name: "Target", slug: targetModel, visibility: "list" }] }),
			kind: "status",
			status: ok,
		}),
		script: (): Said => ({ events: Stream.fromIterable(responseEvents([okMessage])), kind: "events" }),
	}),
};

/** The three mocks, each on its own fresh loopback port from the entry file's `Listener`. */
const mocks = Effect.fnUntraced(function* mocks(vendor: Vendor, holdsPhi: (piece: string) => boolean) {
	const { on } = yield* Listener;
	const freeServer = Layer.build(on(anyFreePort));
	const account = accounts[vendor];
	const judging = serveJudge(sealingWhen(holdsPhi));
	const open = yield* freeServer.pipe(Effect.flatMap((server) => Effect.provideContext(account, server)));
	const baa = yield* freeServer.pipe(Effect.flatMap((server) => Effect.provideContext(account, server)));
	const judge = yield* freeServer.pipe(Effect.flatMap((server) => Effect.provideContext(judging, server)));

	return { baa, judge, open };
});

/** Fresh XDG config and state folders, whose `config.json` names the open, BAA and judge mocks at `endpoints`. */
const folders = Effect.fnUntraced(function* folders(
	vendor: Vendor,
	endpoints: {
		readonly open: string;
		readonly baa: string;
		readonly judge: string;
	},
) {
	const fs = yield* FileSystem.FileSystem;
	const config = yield* fs.makeTempDirectoryScoped({ prefix: "phi-doctor-config-" });
	const state = yield* fs.makeTempDirectoryScoped({ prefix: "phi-doctor-state-" });
	const xdg = { XDG_CONFIG_HOME: config, XDG_STATE_HOME: state };

	const file = Formatter.formatJson({
		clean: [{ endpoint: endpoints.open, forwarded: true, name: "open", vendor }],
		judge: { endpoint: endpoints.judge, keyEnv: "PHI_DOCTOR_JUDGE_KEY" },
		sealed: [{ endpoint: endpoints.baa, keyEnv: "PHI_DOCTOR_BAA_KEY", name: "baa", scheme: "apiKey", vendor }],
		targetModel: { [vendor]: targetModel },
	});

	const target = yield* configFile.pipe(
		Effect.provideService(UserDirectories.UserDirectories, UserDirectories.make()),
		Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env: xdg })),
	);

	yield* writePrivately(target, file);

	return xdg;
});

/**
 * The open mock, the BAA mock and the judge mock, each on its own loopback port, and the `env` of a router that calls
 * them alone: fresh XDG config and state folders whose `config.json` names the open mock as the forwarded clean
 * account, the BAA mock as the keyed sealed account and the judge mock, and the fake keys. Both accounts speak
 * `vendor`'s API. The judge seals each piece `holdsPhi` names and clears the rest. The mocks close and the folders go
 * with the scope.
 */
const mockWorld = Effect.fnUntraced(function* mockWorld(vendor: Vendor, holdsPhi: (piece: string) => boolean) {
	const { baa, judge, open } = yield* mocks(vendor, holdsPhi);
	const xdg = yield* folders(vendor, { baa: baa.endpoint, judge: judge.endpoint, open: open.endpoint });

	const bodies = Effect.map(Array.map(({ body }: { readonly body: string }) => body));

	const arrived: Effect.Effect<Arrived> = Effect.all(
		{ baa: baa.received.pipe(bodies), open: open.received.pipe(bodies) },
		{ concurrency: 1 },
	);

	return { arrived, env: Struct.assign(fakeKeys, xdg) };
});

export { mockWorld };

export type { Arrived, Vendor };
