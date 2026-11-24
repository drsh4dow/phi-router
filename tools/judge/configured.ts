import { ConfigProvider, Context, Effect, FileSystem, Layer, Path, Schema, Struct } from "effect";
import type { Json, Reply } from "#router/client/mock-upstreams/index.ts";
import { Configuration } from "#router/client/configuration/index.ts";
import { Judge } from "#router/client/judge/index.ts";
import { NodeHttpServer } from "@effect/platform-node";
import { serveJudge } from "#router/client/mock-upstreams/index.ts";

type Named = Readonly<Partial<Record<"keyCommand" | "keyEnv" | "model", string>>>;

const jsonOf = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

/** The environment of a temporary config folder whose `config.json` is `file`, with `PHI_TEST_KEY=env-key`. */
const envOf = Effect.fnUntraced(function* envOf(file: Json) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const home = yield* fs.makeTempDirectoryScoped({ prefix: "phi-router-config-" });

	const text = yield* jsonOf(file);

	yield* fs.makeDirectory(path.join(home, "phi-router"));
	yield* fs.writeFileString(path.join(home, "phi-router", "config.json"), text);

	return { PHI_TEST_KEY: "env-key", XDG_CONFIG_HOME: home };
});

/**
 * The environment of a temporary config folder whose `config.json` names a judge block at `endpoint` with these fields.
 */
const configuredEnv = Effect.fnUntraced(function* configuredEnv(endpoint: string, named: Named) {
	return yield* envOf({ judge: Struct.assign({ endpoint }, named) });
});

/** The judge the router picks from a `config.json` that is `file`. */
const judgeFrom = Effect.fnUntraced(function* judgeFrom(file: Json) {
	const env = ConfigProvider.layer(ConfigProvider.fromEnv({ env: yield* envOf(file) }));
	const configured = Judge.layer.pipe(Layer.provide(Configuration.layer));
	const built = yield* Layer.build(Layer.provide(configured, env));

	return Context.get(built, Judge);
});

/** The live judge from a `config.json` whose judge block names `endpoint` and these fields. */
const configuredJudge = Effect.fnUntraced(function* configuredJudge(endpoint: string, named: Named) {
	return yield* judgeFrom({ judge: Struct.assign({ endpoint }, named) });
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

export { configuredEnv, configuredJudge, judgeFrom, mockOn, mockedJudge };

export type { Named };
