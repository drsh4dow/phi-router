import { Array, Effect, FileSystem, Layer, Option, Path, Schema, Stream, String, pipe } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { assert, it } from "@effect/vitest";
import { Digest } from "effect/crypto";
import { NodeServices } from "@effect/platform-node";
import { pinnedJar } from "./tla2tools.ts";

class JavaMissing extends Schema.TaggedError<JavaMissing, { readonly brand: unique symbol }>()("JavaMissing", {
	message: Schema.String,
}) {}

type Folder = "holds" | "breaks";

const noViolationExitCode = 0;

interface Violation {
	readonly exitCode: number;
	readonly line: string;
}

const temporal: Violation = { exitCode: 13, line: "Error: Temporal properties were violated." };

const violationsOf = (text: string): readonly Violation[] =>
	Array.flatMap(String.split(text, "\n"), (line) => {
		if (String.startsWith("INVARIANT ")(line)) {
			return [{ exitCode: 12, line: `Error: Invariant ${String.replace("INVARIANT ", "")(line)} is violated.` }];
		}

		if (String.startsWith("PROPERTY ")(line)) {
			return [temporal];
		}

		return [];
	});

const everyCore = "auto";

const oneWorkerForTheShortestTrace = "1";

const workers: Record<Folder, string> = { breaks: oneWorkerForTheShortestTrace, holds: everyCore };

const patient = { timeout: 300_000 };

const configurations = Effect.fn("configurations")(function* configurations(folder: Folder) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const files = yield* fs.readDirectory(path.join(import.meta.dirname, folder));

	return yield* Effect.forEach(
		Array.sort(files, String.Order),
		(file) => Effect.map(fs.readFileString(path.join(import.meta.dirname, folder, file)), (text) => ({ file, text })),
		{ concurrency: 1 },
	);
});

const tlc = Effect.fn("tlc")(function* tlc(folder: Folder, file: string) {
	const fs = yield* FileSystem.FileSystem;
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const jar = yield* pinnedJar;
	const tmpdirOfThisRun = yield* fs.makeTempDirectoryScoped({ prefix: "phi-router-tlc-" });
	const moduleFile = `${Array.headNonEmpty(String.split(file, "."))}.tla`;

	const args = [
		"-XX:+UseParallelGC",
		`-Djava.io.tmpdir=${tmpdirOfThisRun}`,
		"-cp",
		jar,
		"tlc2.TLC",
		"-workers",
		workers[folder],
		"-metadir",
		tmpdirOfThisRun,
		"-config",
		`${folder}/${file}`,
		moduleFile,
	];

	const command = ChildProcess.make("java", args, { cwd: import.meta.dirname });

	const handle = yield* Effect.mapError(spawner.spawn(command), () =>
		JavaMissing.make({
			message:
				"The model check runs TLC, which needs Java 11 or later, and no `java` runs from PATH. " +
				"Install a JDK and run `bun run check` again. CI installs one in .github/workflows/check.yml.",
		}),
	);

	const output = yield* Stream.mkString(Stream.decodeText(handle.all));
	const exitCode = yield* handle.exitCode;

	return { exitCode, output };
}, Effect.scoped);

const breaksOnItsRule = Effect.fn("breaksOnItsRule")(function* breaksOnItsRule(config: {
	readonly file: string;
	readonly text: string;
}) {
	const expected = violationsOf(config.text);
	const run = yield* tlc("breaks", config.file);

	const reported = Array.filter(
		String.split(run.output, "\n"),
		(line) => String.startsWith("Error: Invariant ")(line) || line === temporal.line,
	);

	assert.deepStrictEqual(
		[run.exitCode],
		pipe(
			expected,
			Array.map((rule) => rule.exitCode),
		),
		run.output,
	);
	assert.deepStrictEqual(
		reported,
		pipe(
			expected,
			Array.map((rule) => rule.line),
		),
		config.file,
	);
});

it.layer(Layer.merge(NodeServices.layer, Digest.layerWebCrypto))("the model", (test) => {
	test.effect(
		"TLC finds no violation in any configuration under holds/",
		() =>
			Effect.gen(function* holds() {
				const found = yield* configurations("holds");

				for (const config of found) {
					const run = yield* tlc("holds", config.file);

					assert.strictEqual(run.exitCode, noViolationExitCode, run.output);
					assert.include(run.output, "Model checking completed. No error has been found.", config.file);
				}
			}),
		patient,
	);

	test.effect(
		"TLC reports exactly the one rule each configuration under breaks/ names",
		() =>
			Effect.gen(function* breaks() {
				const found = yield* configurations("breaks");

				assert.isTrue(
					Option.isSome(Array.findFirst(found, (config) => config.file === "Route.NoStub.cfg")),
					"the configuration with the stub step removed is kept",
				);

				for (const config of found) {
					yield* breaksOnItsRule(config);
				}
			}),
		patient,
	);
});
