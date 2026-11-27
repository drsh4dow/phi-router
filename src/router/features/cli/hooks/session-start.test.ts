import { Array, ConfigProvider, Effect, Option, pipe } from "effect";
import { assert, it } from "@effect/vitest";
import { leasedPid, portOf } from "./session-start.ts";
import { loopback, productPort } from "#shared/cli.ts";
import { providerSwitchOn } from "#router/features/cli/claude/index.ts";

const port = String(productPort);

const routerAddress = `http://${loopback}:${port}`;

it.effect("a model address names a router only as http on the literal loopback with a port and at most a slash", () =>
	Effect.sync(() => {
		const addresses = [
			routerAddress,
			`${routerAddress}/`,
			"",
			`http://localhost:${port}`,
			`https://${loopback}:${port}`,
			`${routerAddress}/v1`,
			`http://${loopback}`,
		];

		assert.deepStrictEqual(pipe(addresses, Array.map(portOf)), [
			Option.some(productPort),
			Option.some(productPort),
			Option.none(),
			Option.none(),
			Option.none(),
			Option.none(),
			Option.none(),
		]);
	}),
);

const switchedOn = [
	["CLAUDE_CODE_USE_BEDROCK", "1"],
	["CLAUDE_CODE_USE_VERTEX", "true"],
	["CLAUDE_CODE_USE_FOUNDRY", " yes "],
	["CLAUDE_CODE_USE_ANTHROPIC_AWS", "On"],
	["CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD", "TRUE"],
	["CLAUDE_CODE_USE_MANTLE", "YES"],
	["CLAUDE_CODE_USE_GATEWAY", "on"],
] as const;

it.effect.each(switchedOn)(
	"%s at %j is on, a switch Claude Code 2.1.330 sends its model requests to another provider by",
	([name, value]) =>
		Effect.gen(function* switched() {
			const environment = ConfigProvider.fromUnknown({ [name]: value });
			const on = yield* Effect.provideService(providerSwitchOn, ConfigProvider.ConfigProvider, environment);

			assert.deepStrictEqual(on, Option.some(name));
		}),
);

const hookShells = [
	{ claude: true, given: 4242, harness: { CLAUDE_PID: "7311" }, leased: 4242 },
	{ claude: true, given: 1, harness: { CLAUDE_PID: "7311" }, leased: 7311 },
	{ claude: true, given: 1, harness: {}, leased: 1 },
	{ claude: true, given: 1, harness: { CLAUDE_PID: "0" }, leased: 1 },
	{ claude: true, given: 1, harness: { CLAUDE_PID: "pid" }, leased: 1 },
	{ claude: false, given: 1, harness: { CLAUDE_PID: "7311" }, leased: 1 },
] as const;

it.effect.each(hookShells)(
	"a hook shell that names parent $given, with $harness and claude $claude, leases pid $leased, as Git Bash names 1 for a Windows parent",
	({ claude, given, harness, leased }) =>
		Effect.gen(function* leases() {
			const environment = ConfigProvider.fromUnknown(harness);

			const pid = yield* Effect.provideService(
				leasedPid({ claude, pid: given }),
				ConfigProvider.ConfigProvider,
				environment,
			);

			assert.strictEqual(pid, leased);
		}),
);
