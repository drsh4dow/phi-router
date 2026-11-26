import { Effect, FileSystem, Formatter, Layer, String as Str, Struct, pipe } from "effect";
import { answers, ran } from "#tools/lifecycle/launched.ts";
import { assert, it } from "@effect/vitest";
import {
	claudeFolders,
	claudeIn,
	folder,
	phiRouter,
	routed,
	settingsFile,
	writeSettings,
	written,
} from "./configured.ts";
import type { ClaudeSettings } from "./configured.ts";
import { FetchHttpClient } from "effect/http";
import { NodeServices } from "@effect/platform-node";
import { pluginCopy } from "#tools/plugin/copied.ts";

const patient = { timeout: 60_000 };

const ok = 0;

const standIn = new URL("stand-in.ts", import.meta.url).pathname;

type Claude = "posts" | "silent" | "absent";

type Install = "whole" | "none" | "launcherNotExecutable" | "noBundle";

const notExecutable = 0o644;

const shellKey = "sk-ant-api03-phi-test-shell-key";

const enabled = { enabledPlugins: { "phi-router@phi-router": true }, env: written };

const seenBy = (marker: string): string => {
	const config = '"$XDG_CONFIG_HOME/phi-router" "$XDG_CONFIG_HOME/phi-router/config.json"';

	const proxy = 'echo "$HTTP_PROXY $HTTPS_PROXY $http_proxy $https_proxy $NO_PROXY $no_proxy"';

	const apiKey = 'echo "$ANTHROPIC_API_KEY"';

	return `{ stat -c %a ${config}; ${proxy}; ${apiKey}; grep -o '"ANTHROPIC_BASE_URL":"http://127.0.0.1:[0-9]*' "$CLAUDE_CONFIG_DIR/settings.json" | grep -o 'http.*'; } > '${marker}'`;
};

const olderVersion = `[ "$1" = --version ] && { echo '2.1.331 (Claude Code)'; exit 0; }`;

const searchPath = Effect.fnUntraced(function* searchPath(claude: Claude) {
	const fs = yield* FileSystem.FileSystem;
	const bin = yield* folder("phi-claude-bin-");
	const marker = `${bin}/claude-ran`;
	const found = yield* ran(["bun", "-e", "process.stdout.write(process.execPath)"], {});
	const bun = found.printed;

	yield* fs.symlink(bun, `${bin}/bun`);

	const runs = { absent: "", posts: `exec '${bun}' '${standIn}' "$@"\n`, silent: "" };

	if (claude !== "absent") {
		yield* fs.writeFileString(`${bin}/claude`, `#!/bin/sh\n${olderVersion}\n${seenBy(marker)}\n${runs[claude]}`, {
			mode: 0o755,
		});
	}

	return { bun, marker, searchPath: `${bin}:/usr/bin:/bin` };
});

const broken = Effect.fnUntraced(function* broken(copy: string, install: Install) {
	const fs = yield* FileSystem.FileSystem;

	if (install === "launcherNotExecutable") {
		yield* fs.chmod(`${copy}/bin/phi-router`, notExecutable);
	}

	if (install === "noBundle") {
		yield* fs.remove(`${copy}/phi-router.mjs`);
	}
});

const installed = Effect.fnUntraced(function* installed(dir: string, install: Install) {
	const fs = yield* FileSystem.FileSystem;

	if (install === "none") {
		return;
	}

	const copy = yield* pluginCopy;

	const record = {
		plugins: { "phi-router@phi-router": [{ installPath: copy, scope: "user", version: "0.1.0" }] },
		version: 2,
	};

	yield* fs.makeDirectory(`${dir}/plugins`);
	yield* fs.writeFileString(`${dir}/plugins/installed_plugins.json`, Formatter.formatJson(record));
	yield* broken(copy, install);
});

const doctored = Effect.fnUntraced(function* doctored(claude: Claude, settings: ClaudeSettings, install: Install) {
	const fs = yield* FileSystem.FileSystem;
	const { dir, env } = yield* claudeFolders;
	const { bun, marker, searchPath: PATH } = yield* searchPath(claude);

	yield* writeSettings(dir, settings);
	yield* installed(dir, install);

	const shell = Struct.assign(env, { ANTHROPIC_API_KEY: shellKey, PATH });
	const bytes = fs.readFileString(settingsFile(dir));
	const before = yield* bytes;
	const doctor = yield* phiRouter(claudeIn(dir).doctor, shell, bun);
	const after = yield* bytes;
	const claudeRan = yield* fs.exists(marker);
	const seen = yield* fs.readFileString(marker).pipe(Effect.orElseSucceed(() => ""));

	return { claudeRan, doctor, kept: after === before, seen: pipe(seen, Str.trim, Str.split("\n")) };
}, Effect.scoped);

const dead = "http://127.0.0.1:9";

const passes = Effect.gen(function* passes() {
	const { doctor, kept, seen } = yield* doctored("posts", enabled, "whole");
	const [folderMode, fileMode, proxy, apiKey, address = ""] = seen;

	assert.strictEqual(doctor.exitCode, ok, doctor.printed);
	assert.deepStrictEqual(
		[folderMode, fileMode, proxy, apiKey, kept],
		["700", "600", `${dead} ${dead} ${dead} ${dead} localhost localhost`, "", true],
		"the mocks' config.json is private while claude runs, behind a dead proxy that localhost alone does not avoid, without the API key of the developer's shell, and the user's settings.json is as it was",
	);
	const port = Number(new URL(address).port);
	const routerAnswers = yield* answers(port);

	assert.isFalse(routerAnswers, "the plugin's router is gone once doctor returns");
	assert.include(doctor.printed, "pass the plugin phi-router@phi-router is installed");
	assert.include(doctor.printed, "pass the canary's prompt arrived at the open mock as the stub [sealed h1]");
	assert.include(doctor.printed, "pass the canary arrived at no open mock");
	assert.include(doctor.printed, "note: Claude Code 2.1.331 is older than 2.1.332");
});

const direct = "no_proxy or NO_PROXY takes Claude Code to http://127.0.0.1:47411 without a proxy";

interface Static {
	readonly named: string;
	readonly settings: ClaudeSettings;
	readonly install: Install;
}

const statics: readonly Static[] = [
	{
		install: "whole",
		named: "ANTHROPIC_BASE_URL",
		settings: Struct.assign(enabled, { env: Struct.omit(written, ["ANTHROPIC_BASE_URL"]) }),
	},
	{
		install: "whole",
		named: direct,
		settings: Struct.assign(enabled, { env: Struct.assign(written, { no_proxy: "localhost" }) }),
	},
	{
		install: "whole",
		named: direct,
		settings: Struct.assign(enabled, { env: Struct.assign(routed, { NO_PROXY: "127.0.0.1:47412" }) }),
	},
	{
		install: "whole",
		named: "phi-router@phi-router is enabled",
		settings: Struct.assign(enabled, { enabledPlugins: { "phi-router@phi-router": false } }),
	},
	{ install: "none", named: "phi-router@phi-router is installed", settings: enabled },
];

const failsStatic = Effect.fnUntraced(function* failsStatic(failing: Static) {
	const { claudeRan, doctor } = yield* doctored("posts", failing.settings, failing.install);

	assert.notStrictEqual(doctor.exitCode, ok);
	assert.match(doctor.printed, new RegExp(`^FAIL [^\n]*${failing.named}`, "mu"));
	assert.isFalse(claudeRan, "claude ran although a static check failed");
});

const keptLists: readonly Lists[] = [
	{ env: Struct.assign(routed, { no_proxy: "*" }), named: "* in the settings", shell: {} },
	{ env: routed, named: "127.0.0.0/8 in the shell's NO_PROXY", shell: { NO_PROXY: "corp.example,127.0.0.0/8" } },
];

interface Lists {
	readonly env: Readonly<Record<string, string>>;
	readonly named: string;
	readonly shell: Readonly<Record<string, string>>;
}

const passesKept = Effect.fnUntraced(function* passesKept({ env, shell }: Lists) {
	const folders = yield* claudeFolders;

	yield* writeSettings(folders.dir, { env });

	const doctor = yield* phiRouter(claudeIn(folders.dir).doctor, Struct.assign(folders.env, shell));

	assert.match(doctor.printed, new RegExp(`^pass ${direct}$`, "mu"));
}, Effect.scoped);

const breaks: readonly { readonly install: Install }[] = [
	{ install: "launcherNotExecutable" },
	{ install: "noBundle" },
];

const failsBroken = Effect.fnUntraced(function* failsBroken({ install }: { readonly install: Install }) {
	const { claudeRan, doctor } = yield* doctored("posts", enabled, install);

	assert.isTrue(claudeRan);
	assert.notStrictEqual(doctor.exitCode, ok);
	assert.include(doctor.printed, "pass the plugin phi-router@phi-router is installed");
	assert.include(doctor.printed, "FAIL the canary's prompt arrived at the open mock as the stub [sealed h1]");
});

const silent = Effect.gen(function* silent() {
	const { claudeRan, doctor } = yield* doctored("silent", enabled, "whole");

	assert.isTrue(claudeRan);
	assert.notStrictEqual(doctor.exitCode, ok);
	assert.include(doctor.printed, "FAIL the canary's prompt arrived at the open mock as the stub [sealed h1]");
});

const absent = Effect.gen(function* absent() {
	const { doctor } = yield* doctored("absent", enabled, "whole");

	assert.notStrictEqual(doctor.exitCode, ok);
	assert.include(doctor.printed, "FAIL claude is on PATH");
});

it.layer(Layer.merge(NodeServices.layer, FetchHttpClient.layer))("doctor claude", (test) => {
	test.effect(
		"passes when the installed plugin's router takes the canary to the open mock only as its stub",
		() => passes,
		patient,
	);
	test.effect.each(statics)("fails naming $named without running claude when its check fails", failsStatic, patient);
	test.effect.each(keptLists)("passes the proxy check for the developer's own $named", passesKept, patient);
	test.effect.each(breaks)("fails on the canary when the installed plugin is $install", failsBroken, patient);
	test.effect("fails naming the BAA check when claude sends nothing", () => silent, patient);
	test.effect("fails naming claude when no claude is on PATH", () => absent, patient);
});
