import { Array, Effect, FileSystem, Layer, Option, Record, String as Str, Struct, pipe } from "effect";
import { answers, ran } from "#tools/lifecycle/launched.ts";
import { assert, it } from "@effect/vitest";
import { codexFolders, codexIn, configFile, dotenvFile, enabled, roleFile, trusted } from "./configured.ts";
import { folder, phiRouter } from "#tools/claude/configured.ts";
import { FetchHttpClient } from "effect/http";
import { NodeServices } from "@effect/platform-node";
import type { PlatformError } from "effect";
import { filePath } from "#tools/file-path.ts";
import { pluginCopy } from "#tools/plugin/copied.ts";

const patient = { timeout: 60_000 };

const ok = 0;

const standIn = filePath(new URL("stand-in.ts", import.meta.url));

type Codex = "posts" | "silent" | "absent";

type Install = "whole" | "none" | "noManifest" | "launcherNotExecutable" | "truncatedBundle";

type Home =
	| "whole"
	| "noAddress"
	| "disabled"
	| "untrusted"
	| "promptUntrusted"
	| "checkUntrusted"
	| "compactUntrusted"
	| "noRole"
	| "noDotenv"
	| "laterNoProxy";

const notExecutable = 0o644;

const half = 2;

const start = 0;

const productPort = 47_411;

const dead = "http://127.0.0.1:9";

const deadProxyVariables = ["ALL_PROXY", "HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"];

const seenBy = (marker: string): string => {
	const config = '"$XDG_CONFIG_HOME/phi-router" "$XDG_CONFIG_HOME/phi-router/config.json"';

	const plugins = '"$CODEX_HOME/plugins"';
	const wide = `find ${plugins} \\( -type d ! -perm 700 \\) -o \\( -type f ! -perm 600 ! -perm 700 \\) | wc -l`;
	const launcher = `stat -c %a ${plugins}/cache/phi-router/phi-router/*/bin/phi-router`;
	const address = `grep -o 'http://127.0.0.1:[0-9]*' "$CODEX_HOME/config.toml"`;

	const proxyValues = pipe(
		[...deadProxyVariables, "NO_PROXY", "no_proxy"],
		Array.map((name) => `$${name}`),
		Array.join(" "),
	);

	const proxy = `echo "${proxyValues}"`;

	const stdin = "timeout 1 cat > /dev/null; echo $?";

	return `{ stat -c %a ${config}; ${address}; ${wide}; ${launcher}; ${proxy}; ${stdin}; } > '${marker}'`;
};

const loadsDotenv = `if [ -f "$CODEX_HOME/.env" ]; then set -a; . "$CODEX_HOME/.env"; set +a; fi; no_proxy=\${NO_PROXY-$no_proxy}`;

const searchPath = Effect.fnUntraced(function* searchPath(codex: Codex) {
	const fs = yield* FileSystem.FileSystem;
	const bin = yield* folder("phi-codex-bin-");
	const marker = `${bin}/codex-ran`;
	const found = yield* ran(["bun", "-e", "process.stdout.write(process.execPath)"], {});
	const bun = found.printed;

	yield* fs.symlink(bun, `${bin}/bun`);

	const runs = { absent: "", posts: `${loadsDotenv}\nexec '${bun}' '${standIn}' "$@"\n`, silent: "" };

	if (codex !== "absent") {
		yield* fs.writeFileString(`${bin}/codex`, `#!/bin/sh\n${seenBy(marker)}\n${runs[codex]}`, { mode: 0o755 });
	}

	return { bun, marker, searchPath: `${bin}:/usr/bin:/bin` };
});

const broken = Effect.fnUntraced(function* broken(version: string, install: Install) {
	const fs = yield* FileSystem.FileSystem;
	const bundle = `${version}/phi-router.mjs`;

	if (install === "noManifest") {
		yield* fs.remove(`${version}/.codex-plugin/plugin.json`);
	}

	if (install === "launcherNotExecutable") {
		yield* fs.chmod(`${version}/bin/phi-router`, notExecutable);
	}

	if (install === "truncatedBundle") {
		const text = yield* fs.readFileString(bundle);

		yield* fs.writeFileString(bundle, Str.slice(start, text.length / half)(text));
	}
});

const installed = Effect.fnUntraced(function* installed(dir: string, install: Install) {
	const fs = yield* FileSystem.FileSystem;
	const cache = `${dir}/plugins/cache/phi-router/phi-router`;

	if (install === "none") {
		return;
	}

	const copy = yield* pluginCopy;

	yield* fs.makeDirectory(cache, { recursive: true });
	yield* fs.copy(copy, `${cache}/0.1.0`);
	yield* broken(`${cache}/0.1.0`, install);
});

const switchedOn = Effect.fnUntraced(function* switchedOn(
	dir: string,
	env: Readonly<Record<string, string>>,
	home: Home,
) {
	const fs = yield* FileSystem.FileSystem;

	yield* phiRouter(codexIn(dir).on, env);

	const config = yield* fs.readFileString(configFile(dir));

	const changed = {
		checkUntrusted: `${config}${enabled}${Str.replace(/\n\[[^\n]*user_prompt_submit:0:2[^\n]*\]\n[^[]*/u, "")(trusted)}`,
		compactUntrusted: `${config}${enabled}${Str.replace(/\n\[[^\n]*pre_compact:0:0[^\n]*\]\n[^[]*/u, "")(trusted)}`,
		disabled: `${config}${Str.replace("true", "false")(enabled)}${trusted}`,
		laterNoProxy: `${config}${enabled}${trusted}`,
		noAddress: `${Str.replace(/^base_url = .*\n/mu, "")(config)}${enabled}${trusted}`,
		noDotenv: `${config}${enabled}${trusted}`,
		noRole: `${config}${enabled}${trusted}`,
		promptUntrusted: `${config}${enabled}${Str.replace(/\n\[[^\n]*user_prompt_submit:0:1[^\n]*\]\n[^[]*/u, "")(trusted)}`,
		untrusted: `${config}${enabled}`,
		whole: `${config}${enabled}${trusted}`,
	};

	yield* fs.writeFileString(configFile(dir), changed[home]);

	const changedFiles: Readonly<Record<string, Effect.Effect<void, PlatformError.PlatformError>>> = {
		laterNoProxy: fs.writeFileString(dotenvFile(dir), "\nNO_PROXY=corp.example\n", { flag: "a" }),
		noDotenv: fs.remove(dotenvFile(dir)),
		noRole: fs.remove(roleFile(dir)),
	};

	yield* Option.getOrElse(Record.get(changedFiles, home), () => Effect.void);
});

const doctored = Effect.fnUntraced(function* doctored(codex: Codex, home: Home, install: Install) {
	const fs = yield* FileSystem.FileSystem;
	const { dir, env } = yield* codexFolders;
	const { bun, marker, searchPath: PATH } = yield* searchPath(codex);

	yield* Effect.all([switchedOn(dir, env, home), installed(dir, install)], { concurrency: 1 });

	const config = fs.readFileString(configFile(dir));
	const before = yield* config;
	const doctor = yield* phiRouter(codexIn(dir).doctor, Struct.assign(env, { PATH }), bun);
	const seenText = fs.readFileString(marker).pipe(Effect.orElseSucceed(() => ""));
	const [after, codexRan, seen] = yield* Effect.all([config, fs.exists(marker), seenText], { concurrency: 1 });

	return { codexRan, doctor, kept: after === before, seen: pipe(seen, Str.trim, Str.split("\n")) };
}, Effect.scoped);

const passes = Effect.gen(function* passes() {
	const { doctor, kept, seen } = yield* doctored("posts", "whole", "whole");
	const [folderMode, fileMode, address = "", notPrivate, launcherMode, proxy, stdinRead] = seen;

	assert.strictEqual(doctor.exitCode, ok, doctor.printed);
	assert.deepStrictEqual(
		{ fileMode, folderMode, kept, launcherMode, notPrivate, proxy, stdinRead },
		{
			fileMode: "600",
			folderMode: "700",
			kept: true,
			launcherMode: "700",
			notPrivate: "0",
			proxy: `${Array.join(Array.replicate(dead, deadProxyVariables.length), " ")} localhost localhost`,
			stdinRead: "0",
		},
		"the mocks' config.json and codex's plugin copy are private, codex runs behind a dead proxy that localhost alone does not avoid with its stdin at its end, and the user's config.toml is as it was",
	);

	const port = Number(new URL(address).port);
	const routerAnswers = yield* answers(port);
	assert.deepStrictEqual(
		{ productPort: port === productPort, routerAnswers },
		{ productPort: false, routerAnswers: false },
		"the plugin's router ran off the product port, and is gone once doctor returns",
	);
	assert.include(doctor.printed, "pass the plugin's hooks are trusted");
	assert.include(doctor.printed, "pass the canary's prompt arrived at the open mock as the stub [sealed h1]");
	assert.include(doctor.printed, "pass the canary arrived at no open mock");
});

interface Static {
	readonly named: string;
	readonly home: Home;
	readonly install: Install;
}

const statics: readonly Static[] = [
	{ home: "noAddress", install: "whole", named: "model_providers.phi.base_url" },
	{ home: "disabled", install: "whole", named: "phi-router@phi-router is enabled" },
	{ home: "whole", install: "none", named: "phi-router@phi-router is installed" },
	{ home: "whole", install: "noManifest", named: "phi-router@phi-router is installed" },
	{ home: "untrusted", install: "whole", named: "hooks are trusted" },
	{ home: "promptUntrusted", install: "whole", named: "hooks are trusted" },
	{ home: "checkUntrusted", install: "whole", named: "hooks are trusted" },
	{ home: "compactUntrusted", install: "whole", named: "hooks are trusted" },
	{ home: "noRole", install: "whole", named: "the role phi-sealed" },
	{ home: "noDotenv", install: "whole", named: ".env ends with" },
	{ home: "laterNoProxy", install: "whole", named: ".env ends with" },
];

const failsStatic = Effect.fnUntraced(function* failsStatic(failing: Static) {
	const { codexRan, doctor } = yield* doctored("posts", failing.home, failing.install);

	assert.notStrictEqual(doctor.exitCode, ok);
	assert.match(doctor.printed, new RegExp(`^FAIL [^\n]*${failing.named}`, "mu"));
	assert.isFalse(codexRan, "codex ran although a static check failed");
});

const breaks: readonly { readonly install: Install }[] = [
	{ install: "launcherNotExecutable" },
	{ install: "truncatedBundle" },
];

const failsBroken = Effect.fnUntraced(function* failsBroken({ install }: { readonly install: Install }) {
	const { codexRan, doctor } = yield* doctored("posts", "whole", install);

	assert.isTrue(codexRan);
	assert.notStrictEqual(doctor.exitCode, ok);
	assert.include(doctor.printed, "pass the plugin phi-router@phi-router is installed");
	assert.include(doctor.printed, "FAIL the canary's prompt arrived at the open mock as the stub [sealed h1]");
});

const silent = Effect.gen(function* silent() {
	const { codexRan, doctor } = yield* doctored("silent", "whole", "whole");

	assert.isTrue(codexRan);
	assert.notStrictEqual(doctor.exitCode, ok);
	assert.include(doctor.printed, "FAIL the canary's prompt arrived at the open mock as the stub [sealed h1]");
});

const absent = Effect.gen(function* absent() {
	const { doctor } = yield* doctored("absent", "whole", "whole");

	assert.notStrictEqual(doctor.exitCode, ok);
	assert.include(doctor.printed, "FAIL codex is on PATH");
});

it.layer(Layer.merge(NodeServices.layer, FetchHttpClient.layer))("doctor codex", (test) => {
	test.effect(
		"passes when the installed plugin's router takes the canary to the open mock only as its stub",
		() => passes,
		patient,
	);
	test.effect.each(statics)("fails naming $named without running codex when its check fails", failsStatic, patient);
	test.effect.each(breaks)("fails on the canary when the installed plugin is $install", failsBroken, patient);
	test.effect("fails naming the BAA check when codex sends nothing", () => silent, patient);
	test.effect("fails naming codex when no codex is on PATH", () => absent, patient);
});
