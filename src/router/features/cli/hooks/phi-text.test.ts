import { Array, Effect } from "effect";
import { assert, it } from "@effect/vitest";
import { sealNotice, statusText } from "./phi-text.ts";
import type { Status } from "#shared/cli.ts";

const statusOf = (substitute: boolean): Omit<typeof Status.Type, "session"> & { readonly session: string } => ({
	accounts: { clean: [{ name: "open", vendor: "anthropic" }], sealed: [{ name: "baa", vendor: "anthropic" }] },
	cleared: 2,
	last: { account: "baa", model: "claude-sealed", substitute },
	sealed: 1,
	session: "s-1",
});

it.effect("/phi and the seal notice name the last request's model, and say it was a substitute only when it was", () =>
	Effect.sync(() => {
		assert.deepStrictEqual(
			Array.map([false, true], (substitute) => ({
				notice: sealNotice({ count: 1, status: statusOf(substitute) }),
				status: statusText(statusOf(substitute)),
			})),
			[
				{
					notice:
						"phi-router: 1 message held patient identifiers and ran only on the BAA account. Last request: baa, model claude-sealed.",
					status:
						"phi-router, session s-1\nLast request: baa, model claude-sealed\nMessages: 1 sealed, 2 cleared\nClean lane: open\nSealed lane: baa",
				},
				{
					notice:
						"phi-router: 1 message held patient identifiers and ran only on the BAA account. Last request: baa, model claude-sealed, a substitute for the requested model.",
					status:
						"phi-router, session s-1\nLast request: baa, model claude-sealed, a substitute for the requested model\nMessages: 1 sealed, 2 cleared\nClean lane: open\nSealed lane: baa",
				},
			],
		);
	}),
);
