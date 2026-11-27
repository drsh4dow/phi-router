import { Array, Option, String as Str, pipe } from "effect";
import { phiCommand, setupEnded, spelling } from "#shared/cli.ts";
import type { HarnessName } from "./harnesses.ts";
import type { SignIn } from "#router/client/harnesses/index.ts";
import type { Vendor } from "#router/client/configuration/index.ts";

type KeyPlace = "env" | "pi" | "saved";

interface FoundKey {
	readonly vendor: Vendor;
	readonly place: KeyPlace;
}

interface Named {
	readonly plan: string;
	readonly account?: string | undefined;
}

const vendorNames = { anthropic: "Anthropic", openai: "OpenAI" } as const;

const keyVariables = { anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY" } as const;

const keyInputs = spelling.setup.keys;

const roleNames = { baa: "Patient data", judge: "PHI check", open: "Everyday work" } as const;

const keyPlaces = {
	env: (vendor: Vendor) => `from ${keyVariables[vendor]}`,
	pi: () => "saved in pi",
	saved: () => "from your last setup",
} as const;

const keyName = ({ place, vendor }: FoundKey): string => `${vendorNames[vendor]} key ${keyPlaces[place](vendor)}`;

const named = (plan: string): Named => ({ plan });

const shown = ({ account, plan }: Named): string =>
	pipe(Option.fromUndefinedOr(account), Option.match({ onNone: () => plan, onSome: (name) => `${plan} · ${name}` }));

const plainSignIns = { apiKey: "an API key", none: "not signed in" } as const;

const signInNamed = (signIn: SignIn): Named => {
	if (signIn.kind === "plan") {
		return { account: signIn.account, plan: signIn.plan };
	}

	if (signIn.kind === "enterprise") {
		return { account: signIn.account, plan: "Claude Enterprise" };
	}

	if (signIn.kind === "provider") {
		return named(signIn.provider);
	}

	return named(plainSignIns[signIn.kind]);
};

const labelWidth = 16;

const rows = (pairs: readonly (readonly [string, string])[]): readonly string[] =>
	pipe(
		pairs,
		Array.map(([label, value]) => `  ${Str.padEnd(labelWidth)(label)}${value}`),
	);

const readyMark = (value: string): string => `${value}   ✓`;

const stops = {
	apiKey:
		"You don't need phi-router. It keeps patient data off a subscription with no BAA, and you're on an API key. Nothing changed.",
	ended: setupEnded,
	gateway: (host: string, whose: string) =>
		`phi-router doesn't work with your ${whose}gateway (${host}) yet. Nothing changed.`,
	mac: "On macOS, phi-router can't add a second Claude sign-in yet: Claude Code keeps sign-ins in the Keychain, and phi-router reads only a file. Nothing changed.",
	noJudge:
		"The PHI check needs an OpenAI key covered by your BAA. Run setup again when you have one. Nothing changed.",
	noSubscription:
		"phi-router runs everyday work on a Claude Pro or Max subscription, so only patient data runs on Claude Enterprise. Get one at https://claude.com/pricing, then run setup again. Nothing changed.",
	provider: (provider: string) => `phi-router doesn't support ${provider} yet. Nothing changed.`,
	signedOut: (title: string, how: string) => `Sign in to ${title} first with ${how}. Nothing changed.`,
} as const;

const keyWanted = {
	anthropic: "your Anthropic key covered by your BAA. Paste it",
	openai: "an OpenAI key covered by your BAA for the PHI check. Paste it",
} as const;

const bothKeysWanted = "two keys covered by your BAA: Anthropic for patient data, OpenAI for the PHI check. Paste them";

const wantedOf = ([first, ...rest]: Array.NonEmptyReadonlyArray<Vendor>): string => {
	if (Array.isReadonlyArrayNonEmpty(rest)) {
		return bothKeysWanted;
	}

	return keyWanted[first];
};

const pasteAsked = (missing: Array.NonEmptyReadonlyArray<Vendor>): string =>
	`I need ${wantedOf(missing)} in \`/plugin configure phi-router\`. I can't see that field. Say done when saved.`;

const windowDone = {
	false: "Done. Type `/reload-plugins` to turn it on.",
	true: "Done. This window is protected.",
} as const;

const codexDone = "Done. In Codex, type `/new`, then `/hooks` and press t to trust phi-router's hooks.";

const shellQuoted = (word: string): string => `'${Str.replaceAll("'", String.raw`'\''`)(word)}'`;

const keyInTerminal = (answersJson: string | undefined): string => {
	const command = pipe(
		Option.fromUndefinedOr(answersJson),
		Option.match({
			onNone: () => "npx phi-router setup codex --apply",
			onSome: (json) => `npx phi-router setup codex --apply --answers ${shellQuoted(json)}`,
		}),
	);

	return `I need an OpenAI key covered by your BAA. In any terminal, run \`${command}\` and paste it there, not here. Then follow its last line.`;
};

const signedInThen: Readonly<Record<HarnessName, string>> = {
	claude: "Say done when it says you're signed in.",
	codex: "Run setup again when it says you're signed in.",
	pi: `When it says you're signed in, type /${phiCommand.name} ${phiCommand.setup} again.`,
};

const signInElsewhere = ({ folder, harness }: { readonly folder: string; readonly harness: HarnessName }): string =>
	`This machine has no browser. In any terminal, run \`CLAUDE_CONFIG_DIR=${shellQuoted(folder)} claude auth login\` and follow the steps. ${signedInThen[harness]}`;

const macNote =
	"Claude Enterprise sign-in isn't available on macOS yet: Claude Code keeps sign-ins in the Keychain, and phi-router reads only a file.";

export {
	codexDone,
	keyInTerminal,
	keyInputs,
	keyName,
	keyVariables,
	macNote,
	named,
	pasteAsked,
	readyMark,
	roleNames,
	rows,
	shown,
	signInElsewhere,
	signInNamed,
	stops,
	vendorNames,
	windowDone,
};

export type { FoundKey, KeyPlace, Named };
