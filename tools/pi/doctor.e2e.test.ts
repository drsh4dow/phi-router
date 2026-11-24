import { Effect, FileSystem, Formatter, Layer, Option, String as Str, Struct } from "effect";
import { answers, ran } from "#tools/lifecycle/launched.ts";
import { assert, it } from "@effect/vitest";
import { folder, phiRouter } from "#tools/claude/configured.ts";
import { packageCopy, piCli } from "#tools/plugin/copied.ts";
import { FetchHttpClient } from "effect/http";
import { NodeServices } from "@effect/platform-node";
import type { PlatformError } from "effect";

const patient = { timeout: 60_000 };

const ok = 0;

type Install =
	| "whole"
	| "none"
	| "relativeSource"
	| "noAgentFolder"
	| "filtered"
	| "namedNotInstalled"
	| "otherPackage"
	| "extensionTruncated"
	| "routerTruncated";

const piWrapper = `#!/bin/sh
here=\${0%/*}
printf '%s\\n' "$ANTHROPIC_OAUTH_TOKEN" >> "$here/pi-logins"
[ "$1" = list ] && printf '%s\\n%s' "$PWD" "$TMPDIR" > "$here/pi-listed"
[ "$1" = list ] || printf '%s\\n%s' "$PHI_ROUTER_PORT" "$TMPDIR" > "$here/pi-prompted"
exec "$here/bun" "$here/pi-cli.js" "$@"
`;

const searchPath = Effect.fnUntraced(function* searchPath(pi: "real" | "absent") {
	const fs = yield* FileSystem.FileSystem;
	const bin = yield* folder("phi-pi-bin-");
	const marker = `${bin}/pi-prompted`;
	const found = yield* ran(["bun", "-e", "process.stdout.write(process.execPath)"], {});
	const bun = found.printed;

	yield* fs.symlink(bun, `${bin}/bun`);

	if (pi === "real") {
		yield* fs.symlink(piCli, `${bin}/pi-cli.js`);
		yield* fs.writeFileString(`${bin}/pi`, piWrapper, { mode: 0o755 });
	}

	return { bin, bun, marker, searchPath: `${bin}:/usr/bin:/bin` };
});

const halves = 2;

const truncated = Effect.fnUntraced(function* truncated(file: string) {
	const fs = yield* FileSystem.FileSystem;
	const text = yield* fs.readFileString(file);

	yield* fs.writeFileString(file, Str.takeLeft(text, text.length / halves));
});

const breakers: Readonly<
	Record<Install, (copy: string) => Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem>>
> = {
	extensionTruncated: (copy) => truncated(`${copy}/plugins/pi/extension.mjs`),
	filtered: () => Effect.void,
	namedNotInstalled: Effect.fnUntraced(function* namedNotInstalled(copy) {
		const fs = yield* FileSystem.FileSystem;

		yield* fs.remove(copy, { recursive: true });
	}),
	noAgentFolder: () => Effect.void,
	none: () => Effect.void,
	otherPackage: Effect.fnUntraced(function* otherPackage(copy) {
		const fs = yield* FileSystem.FileSystem;

		yield* fs.writeFileString(`${copy}/package.json`, Formatter.formatJson({ name: "other" }));
	}),
	relativeSource: () => Effect.void,
	routerTruncated: (copy) => truncated(`${copy}/plugins/claude/phi-router.mjs`),
	whole: () => Effect.void,
};

const sourcesOf = (install: Install, copy: string): readonly unknown[] => {
	if (install === "filtered") {
		return [{ extensions: [], source: copy }];
	}

	if (install === "none") {
		return [];
	}

	if (install === "relativeSource") {
		return ["."];
	}

	return [copy];
};

const agentFolder = Effect.fnUntraced(function* agentFolder(install: Install) {
	const fs = yield* FileSystem.FileSystem;
	const agentDir = yield* folder("phi-pi-agent-");
	const copy = yield* packageCopy;
	const packages = sourcesOf(install, copy);

	if (install === "noAgentFolder") {
		return `${agentDir}/missing`;
	}

	yield* breakers[install](copy);
	yield* fs.writeFileString(`${agentDir}/settings.json`, Formatter.formatJson({ packages }));

	return agentDir;
});

interface Prompted {
	readonly port: string;
	readonly temporary: string;
	readonly temporaryLeft: boolean;
}

const promptSeen = Effect.fnUntraced(function* promptSeen(marker: string) {
	const fs = yield* FileSystem.FileSystem;
	const seen = yield* fs.readFileString(marker).pipe(Effect.option);

	return yield* Option.match(seen, {
		onNone: () => Effect.succeedNone,
		onSome: (text) => {
			const [port, temporary = ""] = Str.split(text, "\n");

			return Effect.map(fs.exists(temporary), (temporaryLeft) =>
				Option.some<Prompted>({ port, temporary, temporaryLeft }),
			);
		},
	});
});

const hostile = {
	ANTHROPIC_OAUTH_TOKEN: "sk-ant-oat01-phi-test-shell-login",
	FORCE_COLOR: "1",
	HTTPS_PROXY: "http://127.0.0.1:9",
	HTTP_PROXY: "http://127.0.0.1:9",
	NODE_OPTIONS: "--require /phi-doctor-test-missing-module.js",
	http_proxy: "http://127.0.0.1:9",
	https_proxy: "http://127.0.0.1:9",
};

const linesIn = Effect.fnUntraced(function* linesIn(bin: string, name: string) {
	const fs = yield* FileSystem.FileSystem;
	const text = yield* fs.readFileString(`${bin}/${name}`).pipe(Effect.orElseSucceed(() => ""));

	return Str.split(Str.trimEnd(text), "\n");
});

type Naming = "--agent-dir" | "PI_CODING_AGENT_DIR" | "HOME";

const named = Effect.fnUntraced(function* named(naming: Naming, agentDir: string, home: string) {
	const fs = yield* FileSystem.FileSystem;

	if (naming === "PI_CODING_AGENT_DIR") {
		return { flags: [], variable: agentDir };
	}

	if (naming === "HOME") {
		yield* fs.makeDirectory(`${home}/.pi`);
		yield* fs.symlink(agentDir, `${home}/.pi/agent`);

		return { flags: [], variable: "" };
	}

	const elsewhere = yield* folder("phi-pi-elsewhere-");

	return { flags: ["--agent-dir", agentDir], variable: elsewhere };
});

const doctored = Effect.fnUntraced(function* doctored(
	pi: "real" | "absent",
	install: Install,
	naming: Naming = "--agent-dir",
) {
	const fs = yield* FileSystem.FileSystem;
	const [home, temporary] = yield* Effect.all([folder("phi-pi-home-"), folder("phi-pi-tmp-")], { concurrency: 1 });
	const agentDir = yield* agentFolder(install);
	const { flags, variable } = yield* named(naming, agentDir, home);
	const { bin, bun, marker, searchPath: PATH } = yield* searchPath(pi);
	const env = Struct.assign(hostile, { HOME: home, PATH, PI_CODING_AGENT_DIR: variable, TMPDIR: temporary });
	const doctor = yield* phiRouter(["doctor", "pi", ...flags], env, bun);
	const prompt = yield* promptSeen(marker);
	const leftInTemporary = yield* fs.readDirectory(temporary);
	const agentFolderLeft = yield* fs.exists(agentDir);
	const logins = yield* linesIn(bin, "pi-logins");
	const listed = yield* linesIn(bin, "pi-listed");
	const listedLeft = yield* Effect.forEach(listed, (made) => fs.exists(made), { concurrency: 1 });

	return { agentFolderLeft, doctor, leftInTemporary, listed, listedLeft, logins, prompt };
}, Effect.scoped);

const leftBehind = Effect.fnUntraced(function* leftBehind(
	{ port, temporary, temporaryLeft }: Prompted,
	leftInTemporary: readonly string[],
) {
	const routerAnswers = yield* answers(Number(port));

	assert.deepStrictEqual(leftInTemporary, [], "doctor leaves nothing in the caller's TMPDIR");
	assert.isTrue(Str.isNonEmpty(temporary), "pi -p runs with a TMPDIR of doctor's");
	assert.isFalse(temporaryLeft, "pi -p's TMPDIR is gone once doctor returns");
	assert.isFalse(routerAnswers, "the package's router is gone once doctor returns");
});

const doctorLogin = "phi-doctor-fake-login";

const passes = Effect.gen(function* passes() {
	const { doctor, leftInTemporary, listed, listedLeft, logins, prompt } = yield* doctored("real", "whole");
	const [working, listTemporary = ""] = listed;

	assert.strictEqual(doctor.exitCode, ok, doctor.printed);
	assert.deepStrictEqual(logins, ["", doctorLogin], "pi list gets no login and pi -p doctor's, never the shell's");
	assert.deepStrictEqual(
		{ apart: working !== listTemporary, listedLeft },
		{ apart: true, listedLeft: [false, false] },
		"pi list runs in a working folder and a TMPDIR of doctor's apart from each other, gone once doctor returns",
	);
	assert.include(doctor.printed, "pass pi installed the package phi-router");
	assert.include(doctor.printed, "pass pi -p exited 0");
	assert.include(doctor.printed, "pass the canary arrived at the BAA mock");
	assert.include(doctor.printed, "pass the canary arrived at no open mock");

	assert.isTrue(Option.isSome(prompt), "pi ran the prompt");

	yield* leftBehind(Option.getOrThrow(prompt), leftInTemporary);
});

const namings: readonly { readonly naming: Naming }[] = [
	{ naming: "--agent-dir" },
	{ naming: "PI_CODING_AGENT_DIR" },
	{ naming: "HOME" },
];

const found = Effect.fnUntraced(function* found({ naming }: { readonly naming: Naming }) {
	const { doctor } = yield* doctored("real", "whole", naming);

	assert.strictEqual(doctor.exitCode, ok, doctor.printed);
	assert.include(doctor.printed, "pass pi installed the package phi-router");
});

const notInstalled: readonly { readonly install: Install }[] = [
	{ install: "none" },
	{ install: "noAgentFolder" },
	{ install: "relativeSource" },
	{ install: "namedNotInstalled" },
	{ install: "otherPackage" },
];

const failsNotInstalled = Effect.fnUntraced(function* failsNotInstalled({ install }: { readonly install: Install }) {
	const { agentFolderLeft, doctor, prompt } = yield* doctored("real", install);

	assert.notStrictEqual(doctor.exitCode, ok);
	assert.include(doctor.printed, "FAIL pi installed the package phi-router");
	assert.isTrue(Option.isNone(prompt), "pi ran a prompt although the package is not installed");
	assert.strictEqual(agentFolderLeft, install !== "noAgentFolder", "doctor makes no agent folder");
});

const filtered = Effect.gen(function* filtered() {
	const { doctor, prompt } = yield* doctored("real", "filtered");

	assert.notStrictEqual(doctor.exitCode, ok);
	assert.include(doctor.printed, "pass pi installed the package phi-router");
	assert.include(doctor.printed, "FAIL pi loads all of the package, which no filter in pi's settings narrows");
	assert.isTrue(Option.isNone(prompt), "pi ran a prompt although pi's settings filter the package");
});

const breaks: readonly { readonly install: Install }[] = [
	{ install: "extensionTruncated" },
	{ install: "routerTruncated" },
];

const failsBroken = Effect.fnUntraced(function* failsBroken({ install }: { readonly install: Install }) {
	const { doctor } = yield* doctored("real", install);

	assert.notStrictEqual(doctor.exitCode, ok);
	assert.include(doctor.printed, "pass pi installed the package phi-router");
	assert.include(doctor.printed, "FAIL the canary arrived at the BAA mock");
});

const absent = Effect.gen(function* absent() {
	const { doctor } = yield* doctored("absent", "whole");

	assert.notStrictEqual(doctor.exitCode, ok);
	assert.include(doctor.printed, "FAIL pi installed the package phi-router");
});

it.layer(Layer.merge(NodeServices.layer, FetchHttpClient.layer))("doctor pi", (test) => {
	test.effect(
		"passes when the installed package's router takes the canary to the BAA mock alone",
		() => passes,
		patient,
	);
	test.effect.each(namings)("finds the package in the agent folder $naming gives", found, patient);
	test.effect.each(notInstalled)(
		"fails naming the install without a prompt when it is $install",
		failsNotInstalled,
		patient,
	);
	test.effect("fails without a prompt when pi's settings filter the package", () => filtered, patient);
	test.effect.each(breaks)("fails on the canary when the installed package is $install", failsBroken, patient);
	test.effect("fails naming the install when no pi is on PATH", () => absent, patient);
});
