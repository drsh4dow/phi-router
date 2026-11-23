import { Config, Effect, FileSystem, String as Str } from "effect";
import { assert, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import { pluginCopy } from "./copied.ts";
import { ran } from "#tools/lifecycle/launched.ts";

const patient = { timeout: 30_000 };

const nodeOnly = Effect.gen(function* nodeOnly() {
	const fs = yield* FileSystem.FileSystem;
	const bin = yield* fs.makeTempDirectoryScoped({ prefix: "phi-node-only-" });
	const node = yield* ran(["sh", "-c", "command -v node"], {});

	yield* fs.symlink(Str.trim(node.printed), `${bin}/node`);

	return bin;
});

const launched = Effect.gen(function* launched() {
	const copy = yield* pluginCopy;
	const searchPath = yield* Config.String("PATH");
	const onlyNode = yield* nodeOnly;
	const both = yield* ran([`${copy}/bin/phi-router`], { PATH: searchPath });
	const node = yield* ran([`${copy}/bin/phi-router`], { PATH: onlyNode });

	assert.deepStrictEqual(
		[both, node],
		[
			{ exitCode: 0, printed: "phi-router runs on the bun platform layer\n" },
			{ exitCode: 0, printed: "phi-router runs on the node platform layer\n" },
		],
	);
}).pipe(Effect.scoped);

/** The launcher of a copy that holds no bundle, as a checkout that was never built leaves it, with its stderr. */
const unbuilt = Effect.gen(function* unbuilt() {
	const fs = yield* FileSystem.FileSystem;
	const copy = yield* pluginCopy;

	yield* fs.remove(`${copy}/phi-router.mjs`);

	const launcher = yield* ran(["sh", "-c", '"$0" doctor claude 2>&1', `${copy}/bin/phi-router`], {});

	assert.deepStrictEqual(launcher, {
		exitCode: 1,
		printed: "This copy of phi-router is not built. Run bun run build in it, or install a release.\n",
	});
}).pipe(Effect.scoped);

/** `doctor` through the launcher under bun, with a fresh home folder, and what the home folder holds after it. */
const doctorHome = Effect.gen(function* doctorHome() {
	const fs = yield* FileSystem.FileSystem;
	const copy = yield* pluginCopy;
	const home = yield* fs.makeTempDirectoryScoped({ prefix: "phi-launcher-home-" });
	const searchPath = yield* Config.String("PATH");

	const doctor = yield* ran([`${copy}/bin/phi-router`, "doctor", "--help"], {
		HOME: home,
		PATH: searchPath,
		XDG_CACHE_HOME: `${home}/.cache`,
	});

	const left = yield* fs.readDirectory(home, { recursive: true });

	assert.deepStrictEqual({ exitCode: doctor.exitCode, left }, { exitCode: 0, left: [] }, doctor.printed);
}).pipe(Effect.scoped);

/** A shell's lists of hosts to keep off its proxy, and the `no_proxy` `on claude` must write for them. */
interface Lists {
	readonly NO_PROXY: string;
	readonly no_proxy: string;
	readonly wrote: string;
}

const shells: readonly Lists[] = [
	{ NO_PROXY: "localhost", no_proxy: "localhost", wrote: "localhost,127.0.0.1:47411" },
	{ NO_PROXY: "corp.example", no_proxy: "", wrote: "corp.example,127.0.0.1:47411" },
	{ NO_PROXY: "", no_proxy: "", wrote: "127.0.0.1:47411" },
];

/** `on claude` through the launcher, from a shell with `lists`. */
const exempted = Effect.fnUntraced(function* exempted({ NO_PROXY, no_proxy, wrote }: Lists) {
	const fs = yield* FileSystem.FileSystem;
	const copy = yield* pluginCopy;
	const home = yield* fs.makeTempDirectoryScoped({ prefix: "phi-launcher-home-" });
	const searchPath = yield* Config.String("PATH");

	const on = yield* ran([`${copy}/bin/phi-router`, "on", "claude", "--config-dir", home], {
		CLAUDE_CONFIG_DIR: "",
		HOME: home,
		NO_PROXY,
		PATH: searchPath,
		no_proxy,
	});

	assert.include(on.printed, `no_proxy=${wrote}\n`, on.printed);
}, Effect.scoped);

it.layer(NodeServices.layer)("the plugin's launcher", (test) => {
	test.effect(
		"runs the bundle under bun when bun is on PATH, and under node when only node is",
		() => launched,
		patient,
	);
	test.effect("stops with how to build it when the copy holds no bundle", () => unbuilt, patient);
	test.effect(
		"runs doctor with no runtime cache, so doctor leaves nothing in the home folder",
		() => doctorHome,
		patient,
	);
	test.effect.each(shells)(
		"gives on claude the shell's own NO_PROXY=$NO_PROXY and no_proxy=$no_proxy, not the 127.0.0.1 it adds for the CLI's own requests",
		exempted,
		patient,
	);
});
