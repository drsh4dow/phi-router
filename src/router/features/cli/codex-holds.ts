import { Array, Option, String as Str, pipe } from "effect";
import { dotted, hookKeys, plugin } from "./codex-settings.ts";
import type { Setting } from "./codex-settings.ts";
import type { Statement } from "#router/primitives/toml.ts";
import { statementsOf } from "#router/primitives/toml.ts";
import { under } from "./codex-config.ts";

const sameKey = Array.makeEquivalence(Str.Equivalence);

const pairs = (text: string): readonly Statement[] =>
	pipe(
		statementsOf(text),
		Array.filter(({ kind }) => kind === "pair"),
	);

/**
 * Whether `text` sets `setting` to the value `on codex` gives it.
 *
 * @param {string} text The file.
 * @returns {Function} Whether a setting holds.
 */
const holds =
	(text: string) =>
	(setting: Setting): boolean =>
		pipe(
			pairs(text),
			Array.some(({ path, value }) => sameKey(path, setting.path) && value === setting.value),
		);

/**
 * Whether `text` enables the plugin, `[plugins."phi-router@phi-router"] enabled = true`.
 *
 * @param {string} text The file.
 * @returns {boolean} Whether it does.
 */
const pluginEnabled = (text: string): boolean =>
	holds(text)({ path: ["plugins", plugin, "enabled"], reason: "", value: "true" });

const trustOf =
	(text: string) =>
	(key: string): Option.Option<string> => {
		const trustKey = ["hooks", "state", key];

		const hashes = pipe(
			pairs(text),
			Array.filter(({ path }) => under(trustKey)(path) && path.length > trustKey.length),
			Array.map(({ path, value }) => `${dotted(Array.drop(path, trustKey.length))} = ${value}`),
		);

		const both = pipe(
			["trusted_hash", "trusted_content_hash"],
			Array.every((name) => pipe(hashes, Array.some(Str.startsWith(`${name} = `)))),
		);

		if (!both) {
			return Option.none();
		}

		return Option.some(Array.join([`[${dotted(trustKey)}]`, ...hashes], "\n"));
	};

/**
 * The trust Codex stored for each of the plugin's hooks, one table each: empty unless the human trusted them all.
 *
 * @param {string} text The file.
 * @returns {string} The tables, or empty.
 */
const hookTrust = (text: string): string =>
	pipe(hookKeys, Array.map(trustOf(text)), Option.all, Option.match({ onNone: () => "", onSome: Array.join("\n") }));

export { holds, hookTrust, pluginEnabled };
