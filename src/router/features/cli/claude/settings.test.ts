import { assert, it } from "@effect/vitest";
import { customHeadersSetting, withCaller, withoutCaller } from "./settings.ts";
import { Effect } from "effect";

const token = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const older = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

const added = Effect.sync(() => {
	assert.deepStrictEqual(
		{
			alone: withCaller(token)(""),
			kept: withCaller(token)(`X-Team: billing\r\nx-phi-router-caller: ${older}`),
		},
		{
			alone: `x-phi-router-caller: ${token}`,
			kept: `X-Team: billing\nx-phi-router-caller: ${token}`,
		},
	);
});

const removed = Effect.sync(() => {
	assert.deepStrictEqual(
		{
			mixed: withoutCaller({ [customHeadersSetting]: `X-Team: billing\nx-phi-router-caller: ${token}` }),
			none: withoutCaller({}),
			only: withoutCaller({ [customHeadersSetting]: `X-PHI-Router-Caller: ${token}` }),
			theirs: withoutCaller({ [customHeadersSetting]: "X-Team: billing" }),
		},
		{
			mixed: { set: { [customHeadersSetting]: "X-Team: billing" }, unset: [] },
			none: { set: {}, unset: [] },
			only: { set: {}, unset: [customHeadersSetting] },
			theirs: { set: {}, unset: [] },
		},
	);
});

it.effect("on adds the caller header after the developer's own headers and replaces an older caller line", () => added);

it.effect(
	"off removes only the caller line, keeps the developer's headers, and leaves headers with no caller line alone",
	() => removed,
);
