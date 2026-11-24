import { Array, Effect, pipe } from "effect";
import { assert, it } from "@effect/vitest";
import { holds, pluginEnabled, provider } from "#router/features/cli/codex/index.ts";
import { turnConfig } from "./codex.ts";

const routerAddress = "http://127.0.0.1:50123";

const held = [
	{ path: [...provider, "base_url"], reason: "", value: `"${routerAddress}/v1"` },
	{ path: [...provider, "request_max_retries"], reason: "", value: "0" },
	{ path: [...provider, "stream_max_retries"], reason: "", value: "0" },
	{ path: [...provider, "auth", "command"], reason: "", value: '"echo"' },
	{ path: ["analytics", "enabled"], reason: "", value: "false" },
	{ path: ["check_for_update_on_startup"], reason: "", value: "false" },
];

it.effect(
	"the canary turn's config.toml sends to the router at the run's address with retries off, a fake login, analytics and the update check off, and the plugin enabled",
	() =>
		Effect.sync(() => {
			const config = turnConfig({ address: routerAddress, trust: "" });

			const missing = pipe(
				held,
				Array.filter((setting) => !holds(config)(setting)),
			);

			assert.deepStrictEqual({ enabled: pluginEnabled(config), missing }, { enabled: true, missing: [] });
		}),
);
