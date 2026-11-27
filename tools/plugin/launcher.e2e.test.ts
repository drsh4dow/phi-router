import { Array, Config, Effect, FileSystem, Path, String as Str, Struct, pipe } from "effect";
import type { PlatformError, Scope } from "effect";
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

const npmLink = Effect.fnUntraced(function* npmLink(copy: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const bin = yield* fs.makeTempDirectoryScoped({ prefix: "phi-npm-bin-" });

	yield* fs.symlink(path.relative(bin, `${copy}/npm-bin.mjs`), `${bin}/phi-router`);

	return `${bin}/phi-router`;
});

interface Launcher {
	readonly name: string;
	readonly at: (
		copy: string,
	) => Effect.Effect<string, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path | Scope.Scope>;
}

const launchers: readonly Launcher[] = [
	{
		at: (copy: string): Effect.Effect<string> => Effect.succeed(`${copy}/bin/phi-router`),
		name: "the sh launcher the hooks run",
	},
	{ at: npmLink, name: "npm's launcher, started through the link npm makes," },
];

const launched = Effect.fnUntraced(function* launched({ at }: Launcher) {
	const copy = yield* pluginCopy;
	const launcher = yield* at(copy);
	const searchPath = yield* Config.String("PATH");
	const onlyNode = yield* nodeOnly;
	const both = yield* ran([launcher], { PATH: searchPath });
	const node = yield* ran([launcher], { PATH: onlyNode });

	assert.deepStrictEqual(
		[both, node],
		[
			{ exitCode: 0, printed: "phi-router runs on the bun platform layer\n" },
			{ exitCode: 0, printed: "phi-router runs on the node platform layer\n" },
		],
	);
}, Effect.scoped);

const unbuilt = Effect.fnUntraced(function* unbuilt({ at }: Launcher) {
	const fs = yield* FileSystem.FileSystem;
	const copy = yield* pluginCopy;
	const launcher = yield* at(copy);

	yield* fs.remove(`${copy}/phi-router.mjs`);

	const run = yield* ran(["sh", "-c", '"$0" doctor claude 2>&1', launcher], {});

	assert.deepStrictEqual(run, {
		exitCode: 1,
		printed: "This copy of phi-router is not built. Run bun run build in it, or install a release.\n",
	});
}, Effect.scoped);

const doctorHome = Effect.fnUntraced(function* doctorHome({ at }: Launcher) {
	const fs = yield* FileSystem.FileSystem;
	const copy = yield* pluginCopy;
	const launcher = yield* at(copy);
	const home = yield* fs.makeTempDirectoryScoped({ prefix: "phi-launcher-home-" });
	const searchPath = yield* Config.String("PATH");

	const doctor = yield* ran([launcher, "doctor", "--help"], {
		HOME: home,
		PATH: searchPath,
		XDG_CACHE_HOME: `${home}/.cache`,
	});

	const left = yield* fs.readDirectory(home, { recursive: true });

	assert.deepStrictEqual({ exitCode: doctor.exitCode, left }, { exitCode: 0, left: [] }, doctor.printed);
}, Effect.scoped);

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

const exemptions = pipe(
	launchers,
	Array.flatMap((launcher) =>
		pipe(
			shells,
			Array.map((lists) => Struct.assign(lists, launcher)),
		),
	),
);

const exempted = Effect.fnUntraced(function* exempted({ NO_PROXY, at, no_proxy, wrote }: Lists & Launcher) {
	const fs = yield* FileSystem.FileSystem;
	const copy = yield* pluginCopy;
	const launcher = yield* at(copy);
	const home = yield* fs.makeTempDirectoryScoped({ prefix: "phi-launcher-home-" });
	const searchPath = yield* Config.String("PATH");

	const on = yield* ran([launcher, "on", "claude", "--config-dir", home], {
		CLAUDE_CONFIG_DIR: "",
		HOME: home,
		NO_PROXY,
		PATH: searchPath,
		no_proxy,
	});

	assert.include(on.printed, `no_proxy=${wrote}\n`, on.printed);
}, Effect.scoped);

it.layer(NodeServices.layer)("the launchers", (test) => {
	test.effect.each(launchers)(
		"$name runs the bundle under bun when bun is on PATH, and under node when only node is",
		launched,
		patient,
	);
	test.effect.each(launchers)("$name stops with how to build it when the copy holds no bundle", unbuilt, patient);
	test.effect.each(launchers)(
		"$name runs doctor with no runtime cache, so doctor leaves nothing in the home folder",
		doctorHome,
		patient,
	);
	test.effect.each(exemptions)(
		"$name gives on claude the shell's own NO_PROXY=$NO_PROXY and no_proxy=$no_proxy, not the 127.0.0.1 it adds for the CLI's own requests",
		exempted,
		patient,
	);
});
