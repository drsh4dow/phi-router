import { Array, ConfigProvider, Effect, Option, pipe } from "effect";
import { assert, it } from "@effect/vitest";
import { loopback, productPort } from "#shared/cli.ts";
import { portOf, providerSwitchOn } from "./session-start.ts";

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
