import { Array, Option, String as Str, pipe } from "effect";
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
	ended: "Setup ended before it finished. Nothing was saved or changed.",
	gateway: (host: string, whose: string) =>
		`phi-router doesn't work with your ${whose}gateway (${host}) yet. Nothing changed.`,
	mac: "On macOS, phi-router can't add a second Claude sign-in yet: Claude Code keeps sign-ins in the Keychain, and phi-router reads only a file. Nothing changed.",
	noJudge:
		"The PHI check needs an OpenAI key covered by your BAA. Run setup again when you have one. Nothing changed.",
	onlyBaa: "You don't need phi-router. Your only account is already covered by your BAA. Nothing changed.",
	provider: (provider: string) => `phi-router doesn't support ${provider} yet. Nothing changed.`,
	signedOut: (title: string, how: string) => `Sign in to ${title} first with ${how}. Nothing changed.`,
} as const;

const macNote =
	"Claude Enterprise sign-in isn't available on macOS yet: Claude Code keeps sign-ins in the Keychain, and phi-router reads only a file.";

const enterpriseNote =
	"! Check that your BAA covers Claude Code through phi-router. Anthropic doesn't cover a custom base URL by default.";

export {
	enterpriseNote,
	keyName,
	keyVariables,
	macNote,
	named,
	readyMark,
	roleNames,
	rows,
	shown,
	signInNamed,
	stops,
	vendorNames,
};

export type { FoundKey, KeyPlace, Named };
