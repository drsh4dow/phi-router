import { Array, Effect, Record, String as Str, pipe } from "effect";
import type { SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import { assert, it } from "@effect/vitest";
import { guardSubmits, recordUse } from "./index.ts";
import { piWire } from "#shared/pi.ts";

const timestamp = "2026-11-22T13:48:06.636Z";

const noCost = { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 };

const selected = (provider: string): SessionEntry => ({
	id: `select-${provider}`,
	modelId: "auto",
	parentId: "",
	provider,
	timestamp,
	type: "model_change",
});

const prompt: SessionEntry = {
	id: "prompt",
	message: { content: "hello there", role: "user", timestamp: 0 },
	parentId: "",
	timestamp,
	type: "message",
};

const reply = (provider: string): SessionEntry => ({
	id: `reply-${provider}`,
	message: {
		api: "anthropic-messages",
		content: [{ text: "ok", type: "text" }],
		model: "auto",
		provider,
		role: "assistant",
		stopReason: "stop",
		timestamp: 0,
		usage: { cacheRead: 0, cacheWrite: 0, cost: noCost, input: 1, output: 1, totalTokens: 2 },
	},
	parentId: "",
	timestamp,
	type: "message",
});

type Entries = SessionManager["getEntries"];

const otherProvider: Entries = () => [selected("anthropic"), prompt, reply("anthropic")];

const served = {
	completed: (): SessionEntry[] => [selected("phi"), prompt, reply("phi")],
	interrupted: (): SessionEntry[] => [selected("phi"), prompt],
	resumedAndAnswered: (): SessionEntry[] => [...otherProvider(), prompt, reply("phi")],
};

const afterRequests = (headers: Readonly<Record<string, string>>): Entries => {
	const entries = [...otherProvider(), prompt];
	const session = { sessionManager: { getEntries: (): SessionEntry[] => [...entries] } };

	const hook = recordUse({
		pi: {
			appendEntry: (customType) => {
				entries.push({ customType, id: `custom-${customType}`, parentId: "", timestamp, type: "custom" });
			},
		},
		routedProvider: "phi",
	});

	hook({ headers }, session);
	hook({ headers }, session);

	return () => [...entries];
};

interface LineEditor {
	onSubmit?: (text: string) => void;
}

interface Submitted {
	readonly handled: readonly string[];
	readonly told: readonly string[];
}

const submitted = (getEntries: Entries, line: string): Submitted => {
	const handled: string[] = [];
	const told: string[] = [];
	const editor: LineEditor = {};

	guardSubmits({
		ctx: {
			sessionManager: { getEntries },
			ui: {
				notify: (message) => {
					told.push(Array.headNonEmpty(Str.split(message, ". ")));
				},
			},
		},
		editor,
		routedProvider: "phi",
	});

	editor.onSubmit = (text): void => {
		handled.push(text);
	};

	editor.onSubmit(line);

	return { handled, told };
};

const uploads = ["/share", " /share ", "/bug", "/bug it broke"];

const prompts = ["/share it", "/bugs", "what does /share send?"];

const blocked = [
	{ handled: [], told: ["phi-router blocked /share"] },
	{ handled: [], told: ["phi-router blocked /share"] },
	{ handled: [], told: ["phi-router blocked /bug"] },
	{ handled: [], told: ["phi-router blocked /bug"] },
];

const each = (getEntries: Entries, lines: readonly string[]): Submitted[] =>
	pipe(
		lines,
		Array.map((line) => submitted(getEntries, line)),
	);

const handedOn = (lines: readonly string[]): Submitted[] =>
	pipe(
		lines,
		Array.map((line) => ({ handled: [line], told: [] })),
	);

it.effect("keeps a line that runs /share or /bug from pi in a session the router served, and says why", () =>
	Effect.sync(() => {
		assert.deepStrictEqual(
			pipe(
				served,
				Record.map((getEntries) => each(getEntries, uploads)),
			),
			{ completed: blocked, interrupted: blocked, resumedAndAnswered: blocked },
		);
	}),
);

it.effect("hands pi a line it sends to the model in a session the router served", () =>
	Effect.sync(() => {
		assert.deepStrictEqual(each(served.completed, prompts), handedOn(prompts));
	}),
);

it.effect("hands pi /share and /bug as before in a session only another provider served", () =>
	Effect.sync(() => {
		assert.deepStrictEqual(each(otherProvider, uploads), handedOn(uploads));
	}),
);

it.effect("marks a session resumed on the router once, before its first request leaves, and no other session", () =>
	Effect.sync(() => {
		const onRouter = afterRequests({ [piWire.sessionHeader]: "" });
		const onOther = afterRequests({ authorization: "Bearer x" });

		assert.deepStrictEqual(
			{ onOther: each(onOther, uploads), onRouter: each(onRouter, uploads) },
			{ onOther: handedOn(uploads), onRouter: blocked },
		);
		assert.deepStrictEqual(
			pipe(
				onRouter(),
				Array.filter((entry) => entry.type === "custom"),
				Array.map((entry) => entry.type),
			),
			["custom"],
		);
	}),
);
