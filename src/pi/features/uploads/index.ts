import { Array, Function, Option, String as Str, pipe } from "effect";
import type {
	BeforeProviderHeadersEvent,
	ExtensionAPI,
	ExtensionHandler,
	ExtensionUIContext,
	SessionManager,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { piWire } from "#shared/pi.ts";

type EditorFactory = NonNullable<ReturnType<ExtensionUIContext["getEditorComponent"]>>;

type Editor = ReturnType<EditorFactory>;

type Submit = (line: string) => void;

/** A built-in command of pi that sends the session off the machine: when pi runs it, and what it sends where. */
interface Upload {
	readonly command: string;
	readonly runs: (line: string) => boolean;
	readonly sends: string;
}

/**
 * `/share` and `/bug`, matched as pi's own submit handler matches them, so a line pi would send to the model passes.
 * `/bug` reaches this list because it can upload the transcript and a model's summary of it.
 */
const uploads: readonly Upload[] = [
	{
		command: "/share",
		runs: (line) => line === "/share",
		sends: "would upload the whole session to Radius or a GitHub gist",
	},
	{
		command: "/bug",
		runs: (line) => line === "/bug" || Str.startsWith("/bug ")(line),
		sends: "can send its transcript, a model's summary of it and its errors to the pi developers",
	},
];

/** The entry the package adds to a session before a request of the router's provider that pi left no record of. */
const usedEntry = "phi-router-used";

interface UsageContext {
	readonly sessionManager: Pick<SessionManager, "getEntries">;
}

/**
 * Whether the session holds a record, on any branch, that it used `provider` before or as a request left. pi records
 * that a session selected the model when it starts on it or switches to it, and records each reply. A session resumed
 * with `--model` gets no selection from pi, so `recordUse` adds the package's own entry before its first request.
 *
 * @param {UsageContext} ctx The session.
 * @param {string} provider The router's provider in pi.
 * @returns {boolean} Whether the session used `provider`.
 */
const used = (ctx: UsageContext, provider: string): boolean =>
	Array.some(
		ctx.sessionManager.getEntries(),
		(entry) =>
			(entry.type === "model_change" && entry.provider === provider) ||
			(entry.type === "message" && entry.message.role === "assistant" && entry.message.provider === provider) ||
			(entry.type === "custom" && entry.customType === usedEntry),
	);

interface Sent {
	readonly headers: Readonly<BeforeProviderHeadersEvent["headers"]>;
}

/** Where the header hook records a use of the router's provider. */
interface Recorder {
	readonly pi: Pick<ExtensionAPI, "appendEntry">;
	readonly provider: string;
}

/**
 * The header hook that adds the package's entry to a session before a request of the router's provider leaves, unless
 * the session already records a use of it. The session header marks a request of that provider. pi writes the entry to
 * the session file before the hook returns.
 *
 * @param {Recorder} recorder Where the entry goes, and the router's provider in pi.
 * @returns {(event: Sent, ctx: UsageContext) => void} The hook.
 */
const recordUse =
	({ pi, provider }: Recorder) =>
	(event: Sent, ctx: UsageContext): void => {
		if (piWire.sessionHeader in event.headers && !used(ctx, provider)) {
			pi.appendEntry(usedEntry);
		}
	};

interface UploadContext extends UsageContext {
	readonly ui: Pick<ExtensionUIContext, "notify">;
}

/**
 * Why the router refuses `line` in the session of `ctx`: the line runs an upload and the session used `provider`.
 *
 * @param {UploadContext} ctx The session.
 * @param {string} provider The router's provider in pi.
 * @param {string} line The line the user submitted.
 * @returns {Option.Option<string>} Why it is refused, or none when pi may run it.
 */
const refusal = (ctx: UploadContext, provider: string, line: string): Option.Option<string> =>
	pipe(
		Array.findFirst(uploads, (upload) => upload.runs(Str.trim(line))),
		Option.filter(() => used(ctx, provider)),
		Option.map(
			({ command, sends }) =>
				`phi-router blocked ${command}. This session sent requests through the router, so it can hold sealed content, and ${command} ${sends}.`,
		),
	);

/** An editor to guard, in the session of `ctx` that `provider` may have served. */
interface Guarded {
	readonly ctx: UploadContext;
	readonly editor: Readonly<Pick<Editor, "onSubmit">>;
	readonly provider: string;
}

/**
 * Checks each line `editor` submits before pi's handler sees it, and tells the user why when it refuses one. pi sets
 * `onSubmit` once it has the editor, so a setter keeps pi's handler and the getter hands out the check in front of it.
 *
 * @param {Guarded} guarded The editor, which gains the check in place, the session and the router's provider in pi.
 */
const guardSubmits = ({ ctx, editor, provider }: Guarded): void => {
	let submit: Submit = editor.onSubmit ?? Function.constVoid;

	const checked: Submit = (line) => {
		Option.match(refusal(ctx, provider, line), {
			onNone: () => {
				submit(line);
			},
			onSome: (why) => {
				ctx.ui.notify(why, "error");
			},
		});
	};

	Object.defineProperty(editor, "onSubmit", {
		get: () => checked,
		set: (next: Editor["onSubmit"]) => {
			submit = next ?? Function.constVoid;
		},
	});
};

/**
 * The session hook that keeps a session that used `provider` from leaving the machine through `/share` or `/bug`. It
 * guards the editor another extension set, or pi's own, which pi builds with its status in the border. pi drops the
 * editor when the session is replaced, and this hook runs again for the next one.
 *
 * @param {string} provider The router's provider in pi.
 * @returns {ExtensionHandler<SessionStartEvent>} The hook.
 */
const blockUploads =
	(provider: string): ExtensionHandler<SessionStartEvent> =>
	(_event, ctx) => {
		const built: EditorFactory =
			ctx.ui.getEditorComponent() ??
			((tui, theme, keybindings) => new CustomEditor(tui, theme, keybindings, { embedWorkingStatus: true }));

		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			const editor = built(tui, theme, keybindings);

			guardSubmits({ ctx, editor, provider });

			return editor;
		});
	};

export { blockUploads, guardSubmits, recordUse };
