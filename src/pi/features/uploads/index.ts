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

interface UploadCommand {
	readonly command: string;
	readonly runs: (line: string) => boolean;
	readonly sends: string;
}

const uploads: readonly UploadCommand[] = [
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

const usedEntry = "phi-router-used";

interface UsageContext {
	readonly sessionManager: Pick<SessionManager, "getEntries">;
}

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

interface Recorder {
	readonly pi: Pick<ExtensionAPI, "appendEntry">;
	readonly routedProvider: string;
}

const recordUse =
	({ pi, routedProvider }: Recorder) =>
	(event: Sent, ctx: UsageContext): void => {
		if (piWire.sessionHeader in event.headers && !used(ctx, routedProvider)) {
			pi.appendEntry(usedEntry);
		}
	};

interface UploadContext extends UsageContext {
	readonly ui: Pick<ExtensionUIContext, "notify">;
}

const refusal = (ctx: UploadContext, provider: string, line: string): Option.Option<string> =>
	pipe(
		Array.findFirst(uploads, (upload) => upload.runs(Str.trim(line))),
		Option.filter(() => used(ctx, provider)),
		Option.map(
			({ command, sends }) =>
				`phi-router blocked ${command}. This session sent requests through the router, so it can hold sealed content, and ${command} ${sends}.`,
		),
	);

interface Guarded {
	readonly ctx: UploadContext;
	readonly editor: Readonly<Pick<Editor, "onSubmit">>;
	readonly routedProvider: string;
}

const guardSubmits = ({ ctx, editor, routedProvider }: Guarded): void => {
	let submit: Submit = editor.onSubmit ?? Function.constVoid;

	const checked: Submit = (line) => {
		Option.match(refusal(ctx, routedProvider, line), {
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

const blockUploads =
	(routedProvider: string): ExtensionHandler<SessionStartEvent> =>
	(_event, ctx) => {
		const built: EditorFactory =
			ctx.ui.getEditorComponent() ??
			((tui, theme, keybindings) => new CustomEditor(tui, theme, keybindings, { embedWorkingStatus: true }));

		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			const editor = built(tui, theme, keybindings);

			guardSubmits({ ctx, editor, routedProvider });

			return editor;
		});
	};

export { blockUploads, guardSubmits, recordUse };
