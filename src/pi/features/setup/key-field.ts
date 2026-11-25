import type { Component, KeybindingsManager, TUI } from "@earendil-works/pi-tui";
import { Input, truncateToWidth } from "@earendil-works/pi-tui";
import { Redacted, String as Str } from "effect";
import type { Theme } from "@earendil-works/pi-coding-agent";

const shownTail = 6;

const noneHidden = 0;

const narrowest = 1;

const mark = "> ";

const masked = (typed: string, width: number): string => {
	const hidden = Math.max(typed.length - shownTail, noneHidden);
	const shown = `${Str.repeat(hidden)("*")}${Str.slice(hidden)(typed)}`;

	return Str.slice(-Math.max(width - mark.length, narrowest))(shown);
};

type Typed = { readonly kind: "typed"; readonly key: Readonly<Redacted.Redacted> } | { readonly kind: "ended" };

interface Field {
	readonly prompt: string;
	readonly theme: Readonly<Pick<Theme, "fg">>;
	readonly tui: Readonly<Pick<TUI, "requestRender">>;
	readonly done: (typed: Typed) => void;
}

type KeyField = Required<Pick<Component, "handleInput" | "invalidate" | "render">>;

type KeyFieldFactory = (
	...made: readonly [
		tui: Field["tui"],
		theme: Field["theme"],
		keybindings: Readonly<Pick<KeybindingsManager, "matches">>,
		done: Field["done"],
	]
) => KeyField;

const keyField = ({ done, prompt, theme, tui }: Field): KeyField => {
	const input = new Input();

	input.onSubmit = (value): void => {
		const key = Str.trim(value);

		if (Str.isNonEmpty(key)) {
			done({ key: Redacted.make(key), kind: "typed" });
		}
	};

	input.onEscape = (): void => {
		done({ kind: "ended" });
	};

	const hint = `${theme.fg("dim", "enter")}${theme.fg("muted", " submit")}  ${theme.fg("dim", "escape")}${theme.fg("muted", " cancel")}`;

	return {
		handleInput: (data): void => {
			input.handleInput(data);
			tui.requestRender();
		},
		invalidate: (): void => {
			input.invalidate();
		},
		render: (width) => {
			const border = theme.fg("border", Str.repeat(width)("─"));
			const padded = (line: string): string => truncateToWidth(` ${line}`, width);

			return [
				border,
				"",
				padded(theme.fg("accent", prompt)),
				"",
				`${mark}${masked(input.getValue(), width)}`,
				"",
				padded(hint),
				"",
				border,
			];
		},
	};
};

export { keyField };

export type { KeyField, KeyFieldFactory, Typed };
