import { Array, Option, String as Str, pipe } from "effect";
import { dotted, hookKeys, pluginId } from "./settings.ts";
import type { Setting } from "./settings.ts";
import type { Statement } from "#router/primitives/toml.ts";
import { statementsOf } from "#router/primitives/toml.ts";
import { under } from "./config.ts";

const sameKey = Array.makeEquivalence(Str.Equivalence);

const pairs = (text: string): readonly Statement[] =>
	pipe(
		statementsOf(text),
		Array.filter(({ kind }) => kind === "pair"),
	);

const holds =
	(text: string) =>
	(setting: Setting): boolean =>
		pipe(
			pairs(text),
			Array.some(({ path, value }) => sameKey(path, setting.path) && value === setting.value),
		);

const pluginEnabled = (text: string): boolean =>
	holds(text)({ path: ["plugins", pluginId, "enabled"], reason: "", value: "true" });

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

const hookTrust = (text: string): string =>
	pipe(hookKeys, Array.map(trustOf(text)), Option.all, Option.match({ onNone: () => "", onSome: Array.join("\n") }));

export { holds, hookTrust, pluginEnabled };
