import { Array, Effect, Option, Struct, pipe } from "effect";
import { assert, it } from "@effect/vitest";
import { installFailure, moveOf } from "./install.ts";
import type { Installed } from "./harnesses.ts";

const failed = 1;

const succeeded = 0;

it.effect("an installer that exits non-zero stops setup with its output, and one that exits 0 does not", () =>
	Effect.sync(() => {
		const failures = Array.map([failed, succeeded], (exitCode) =>
			installFailure({ name: "claude", turn: { exitCode, kind: "exited", printed: "marketplace not found" } }),
		);

		assert.deepStrictEqual(failures, [
			Option.some("The install in Claude Code failed:\nmarketplace not found"),
			Option.none(),
		]);
	}),
);

const channel = { channel: "release", version: "0.10.0" };

const checkout = Struct.assign(channel, { checkout: "/home/you/phi-router" });

const found: readonly (readonly [string, Installed])[] = [
	["nothing installed", { kind: "absent" }],
	["a checkout", { kind: "elsewhere", version: "0.1.0" }],
	["a release tag", { kind: "held", version: "0.3.0" }],
	["the channel at an older version", { kind: "channel", version: "0.9.0" }],
	["the channel at a prerelease of this version", { kind: "channel", version: "0.10.0-rc.1" }],
	["the channel at this version", { kind: "channel", version: "0.10.0" }],
	["the channel at a newer version", { kind: "channel", version: "0.10.1" }],
];

it.effect(
	"setup installs what is absent, moves a held install to the channel, updates an older one, and never moves an install backwards or off a checkout",
	() =>
		Effect.sync(() => {
			const moves = pipe(
				found,
				Array.map(([name, installed]) => [
					name,
					Option.getOrElse(moveOf({ installed, target: channel }), () => "none"),
					Option.getOrElse(moveOf({ installed, target: checkout }), () => "none"),
				]),
			);

			assert.deepStrictEqual(moves, [
				["nothing installed", "install", "install"],
				["a checkout", "none", "none"],
				["a release tag", "move", "none"],
				["the channel at an older version", "update", "none"],
				["the channel at a prerelease of this version", "update", "none"],
				["the channel at this version", "none", "none"],
				["the channel at a newer version", "none", "none"],
			]);
		}),
);
