import { ConfigProvider, Context, Effect, FileSystem, Layer, Path, Schema, Struct } from "effect";
import { Configuration } from "#router/client/configuration.ts";
import { Judge } from "#router/client/judge.ts";
import { NodeHttpServer } from "@effect/platform-node";
import type { Reply } from "#router/client/mock-upstreams.ts";
import { serveJudge } from "#router/client/mock-upstreams.ts";

type Named = Readonly<Partial<Record<"keyCommand" | "keyEnv" | "model", string>>>;

const jsonOf = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

/**
 * The environment of a temporary config folder whose `config.json` names `endpoint` and these fields, with
 * `PHI_TEST_KEY=env-key`.
 */
const configuredEnv = Effect.fnUntraced(function* configuredEnv(endpoint: string, named: Named) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const home = yield* fs.makeTempDirectoryScoped({ prefix: "phi-router-config-" });
	const file = yield* jsonOf({ judge: Struct.assign({ endpoint }, named) });

	yield* fs.makeDirectory(path.join(home, "phi-router"));
	yield* fs.writeFileString(path.join(home, "phi-router", "config.json"), file);

	return { PHI_TEST_KEY: "env-key", XDG_CONFIG_HOME: home };
});

/** The live judge, built from `configuredEnv`, with the default model `the-default`. */
const configuredJudge = Effect.fnUntraced(function* configuredJudge(endpoint: string, named: Named) {
	const env = ConfigProvider.layer(ConfigProvider.fromEnv({ env: yield* configuredEnv(endpoint, named) }));

	const configured = Judge.layer.pipe(Layer.provide(Configuration.layer({ judgeModel: "the-default" })));
	const built = yield* Layer.build(Layer.provide(configured, env));

	return Context.get(built, Judge);
});

/** A judge mock on its own loopback port that answers by `script`. */
const mockOn = Effect.fnUntraced(function* mockOn(script: (piece: string) => Reply) {
	const server = yield* Layer.build(NodeHttpServer.layerTest);

	return yield* Effect.provideContext(serveJudge(script), server);
});

/** A judge mock that answers by `script`, and the live judge configured against it. */
const mockedJudge = Effect.fnUntraced(function* mockedJudge(script: (piece: string) => Reply, named: Named) {
	const mock = yield* mockOn(script);
	const judge = yield* configuredJudge(mock.endpoint, named);

	return { judge, mock };
});

export { configuredEnv, configuredJudge, mockOn, mockedJudge };

export type { Named };
