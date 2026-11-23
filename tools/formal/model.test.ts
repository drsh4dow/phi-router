import { Array, Effect, FileSystem, Layer, Option, Path, Schema, Stream, String, pipe } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { assert, it } from "@effect/vitest";
import { Digest } from "effect/crypto";
import { NodeServices } from "@effect/platform-node";
import { installedJar } from "./tla2tools.ts";

/** No `java` runs from PATH. */
class JavaMissing extends Schema.TaggedError<JavaMissing, { readonly brand: unique symbol }>()("JavaMissing", {
	message: Schema.String,
}) {}

type Folder = "holds" | "breaks";

/** TLC's exit code for a check that found no violation. */
const passed = 0;

interface Violation {
	readonly exitCode: number;
	readonly line: string;
}

const temporal: Violation = { exitCode: 13, line: "Error: Temporal properties were violated." };

/**
 * What TLC reports when the rules a configuration under breaks/ names are broken. It names a broken invariant, and a
 * broken temporal property only by its kind.
 *
 * @param {string} text The configuration's text.
 * @returns {readonly Violation[]} One violation for each rule the configuration names.
 */
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

/** A run that must pass explores on every core. A run that must break uses one worker, which keeps its trace the shortest. */
const workers: Record<Folder, string> = { breaks: "1", holds: "auto" };

const patient = { timeout: 300_000 };

/** The configurations in one folder, with the text of each. */
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

/**
 * Runs TLC on `<folder>/<file>`, whose module is the file name up to its first dot, and returns
 * its exit code and everything it printed. Each run gets its own temporary folder, because TLC
 * unpacks its standard modules into `java.io.tmpdir` and two runs that share it can read each
 * other's half-written files.
 */
const tlc = Effect.fn("tlc")(function* tlc(folder: Folder, file: string) {
	const fs = yield* FileSystem.FileSystem;
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const jar = yield* installedJar;
	const scratch = yield* fs.makeTempDirectoryScoped({ prefix: "phi-router-tlc-" });

	const args = [
		"-XX:+UseParallelGC",
		`-Djava.io.tmpdir=${scratch}`,
		"-cp",
		jar,
		"tlc2.TLC",
		"-workers",
		workers[folder],
		"-metadir",
		scratch,
		"-config",
		`${folder}/${file}`,
		`${Array.headNonEmpty(String.split(file, "."))}.tla`,
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

/** Runs TLC on one configuration under breaks/ and checks that it reports exactly the rule the configuration names. */
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

					assert.strictEqual(run.exitCode, passed, run.output);
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
