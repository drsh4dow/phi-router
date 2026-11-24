import { Array, Effect, FileSystem, Record, Struct, pipe } from "effect";
import { assert, it } from "@effect/vitest";
import { claudeFolders, claudeIn, phiRouter, routed, settingsFile, settingsIn, writeSettings } from "./configured.ts";
import { NodeServices } from "@effect/platform-node";

const patient = { timeout: 30_000 };

const record = { replaced: "PHI_ROUTER_REPLACED_no_proxy", wrote: "PHI_ROUTER_WROTE_no_proxy" } as const;

interface Lists {
	readonly added: Readonly<Record<string, string>>;
	readonly env: Readonly<Record<string, string>>;
	readonly named: string;
	readonly shell: Readonly<Record<string, string>>;
}

const entry = "127.0.0.1:47411";

const wrote = (value: string): Readonly<Record<string, string>> => ({ [record.wrote]: value, no_proxy: value });

const replaced = (own: string, value: string): Readonly<Record<string, string>> =>
	Struct.assign(wrote(value), { [record.replaced]: own });

const lists: readonly Lists[] = [
	{ added: wrote(entry), env: {}, named: "nothing set", shell: {} },
	{
		added: replaced("", entry),
		env: { NO_PROXY: "", no_proxy: "" },
		named: "both spellings empty in the settings",
		shell: { NO_PROXY: "localhost", no_proxy: "localhost" },
	},
	{
		added: {},
		env: { NO_PROXY: `corp.example,${entry}`, no_proxy: `corp.example,${entry}` },
		named: "already exempt in the settings",
		shell: {},
	},
	{
		added: {},
		env: { no_proxy: "*" },
		named: "* in the settings",
		shell: { NO_PROXY: "localhost", no_proxy: "localhost" },
	},
	{ added: {}, env: {}, named: "* in the shell", shell: { NO_PROXY: "*", no_proxy: "*" } },
	{
		added: {},
		env: {},
		named: "127.0.0.1 in a space list in the shell",
		shell: { NO_PROXY: "localhost 127.0.0.1", no_proxy: "" },
	},
	{
		added: replaced("corp.example", `corp.example,${entry}`),
		env: { no_proxy: "corp.example" },
		named: "no_proxy alone in the settings",
		shell: {},
	},
	{
		added: wrote(`localhost,${entry}`),
		env: { NO_PROXY: "corp.example" },
		named: "NO_PROXY alone in the settings",
		shell: { no_proxy: "localhost" },
	},
	{
		added: wrote(`corp.example,${entry}`),
		env: {},
		named: "NO_PROXY alone in the shell",
		shell: { NO_PROXY: "corp.example" },
	},
];

const claudeFile = (env: Readonly<Record<string, string>>): string => {
	const model = '  "model": "opus"\n}\n';

	if (Record.isEmptyRecord(env)) {
		return `{\n${model}`;
	}

	const lines = pipe(
		Record.toEntries(env),
		Array.map(([name, value]) => `    "${name}": "${value}"`),
		Array.join(",\n"),
	);

	return `{\n  "env": {\n${lines}\n  },\n${model}`;
};

const roundTrip = Effect.fnUntraced(function* roundTrip({ added, env, shell }: Lists) {
	const fs = yield* FileSystem.FileSystem;
	const folders = yield* claudeFolders;
	const bytes = fs.readFileString(settingsFile(folders.dir));
	const before = claudeFile(env);
	const ran = Struct.assign(folders.env, shell);

	yield* fs.writeFileString(settingsFile(folders.dir), before);

	const once = yield* phiRouter(claudeIn(folders.dir).on, ran).pipe(Effect.andThen(settingsIn(folders.dir)));
	const twice = yield* phiRouter(claudeIn(folders.dir).on, ran).pipe(Effect.andThen(settingsIn(folders.dir)));
	const after = yield* phiRouter(claudeIn(folders.dir).off, ran).pipe(Effect.andThen(bytes));

	assert.deepStrictEqual(
		{ after, once, twice },
		{ after: before, once: { env: Struct.assign(Struct.assign(env, routed), added), model: "opus" }, twice: once },
	);
}, Effect.scoped);

const changed = Effect.gen(function* changed() {
	const { dir, env } = yield* claudeFolders;
	const own = `corp.example,${entry},extra.example`;
	const onWrote = Struct.assign(routed, replaced("corp.example", `corp.example,${entry}`));

	yield* writeSettings(dir, { env: { no_proxy: "corp.example" } });
	const once = yield* phiRouter(claudeIn(dir).on, env).pipe(Effect.andThen(settingsIn(dir)));

	yield* writeSettings(dir, { env: Struct.assign(onWrote, { no_proxy: own }) });

	const after = yield* phiRouter(claudeIn(dir).off, env).pipe(Effect.andThen(settingsIn(dir)));

	assert.deepStrictEqual({ after, once }, { after: { env: { no_proxy: own } }, once: { env: onWrote } });
}).pipe(Effect.scoped);

const removedSince = Effect.gen(function* removedSince() {
	const { dir, env } = yield* claudeFolders;

	yield* writeSettings(dir, { env: { no_proxy: "corp.example" } });
	yield* phiRouter(claudeIn(dir).on, env);
	yield* writeSettings(dir, {
		env: Struct.assign(routed, { [record.replaced]: "corp.example", [record.wrote]: "corp.example" }),
	});

	const once = yield* phiRouter(claudeIn(dir).on, env).pipe(Effect.andThen(settingsIn(dir)));
	const after = yield* phiRouter(claudeIn(dir).off, env).pipe(Effect.andThen(settingsIn(dir)));

	assert.deepStrictEqual({ after, once }, { after: {}, once: { env: Struct.assign(routed, wrote(entry)) } });
}).pipe(Effect.scoped);

it.layer(NodeServices.layer)("the router's exemption from the developer's proxy in settings.json", (test) => {
	test.effect.each(lists)(
		"$named: on writes no_proxy only when they would send Claude Code to the router through a proxy, a second on changes nothing, and off gives the file back byte for byte",
		roundTrip,
		patient,
	);
	test.effect(
		"on after the developer removed no_proxy forgets the value it replaced, so off removes the no_proxy it wrote",
		() => removedSince,
		patient,
	);
	test.effect("off leaves a no_proxy the developer changed since on, and removes the record", () => changed, patient);
});
