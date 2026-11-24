import { Array, Effect, FileSystem, Option, Path } from "effect";
import { Base64Url } from "effect/encoding";

const start = 1_780_000_000_000;

const day = 86_400_000;

const tenDays = 864_000_000;

const thirtyDays = 2_592_000_000;

const millisPerSecond = 1000;

const executable = 0o755;

const dayLong = { ends: start + thirtyDays, expires: start + day };

const renewedUntil = start + tenDays;

const jwt = (expires: number, label: string): string =>
	`e30.${Base64Url.encode(`{"exp":${String(Math.floor(expires / millisPerSecond))}}`)}.phi-test-codex-signature-${label}`;

const logins = {
	claude: {
		account: Option.none<string>(),
		file: ".credentials.json",
		renews: (renewed: string) => [
			'[ "$*" = "auth status --json" ] || exit 4',
			`printf '%s' '${renewed}' > "$CLAUDE_CONFIG_DIR/.credentials.json"`,
		],
		standIn: "claude",
		text: (token: string, expires: number, ends: number) =>
			`{"claudeAiOauth":{"accessToken":"${token}","expiresAt":${String(expires)},"refreshTokenExpiresAt":${String(ends)}}}`,
		token: (_expires: number, label: string) => `phi-test-claude-token-${label}`,
	},
	codex: {
		account: Option.some("phi-test-codex-account"),
		file: "auth.json",
		renews: (renewed: string) => [
			'[ "$*" = "app-server" ] || exit 4',
			'PATH="$PATH:/usr/bin:/bin"',
			"read -r initialize",
			"read -r initialized",
			"read -r account",
			`case "$account" in *'"refreshToken":true'*) ;; *) exit 5 ;; esac`,
			`(sleep 0.2; printf '%s' '${renewed}' > "$CODEX_HOME/auth.json"; printf '%s\\n' '{"id":2,"result":{"account":null}}') &`,
			"while read -r line; do :; done",
			"kill $!",
		],
		standIn: "codex",
		text: (token: string) =>
			`{"auth_mode":"chatgpt","tokens":{"access_token":"${token}","account_id":"phi-test-codex-account"}}`,
		token: jwt,
	},
} as const;

type Vendor = keyof typeof logins;

interface Lifetime {
	readonly ends: number;
	readonly expires: number;
	readonly standInRuns?: string;
}

const loggedIn = Effect.fnUntraced(function* loggedIn(vendor: Vendor, first: Lifetime, at?: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const login = logins[vendor];

	const folder = yield* Option.match(Option.fromUndefinedOr(at), {
		onNone: () => fs.makeTempDirectoryScoped({ prefix: "phi-router-login-" }),
		onSome: (given) => Effect.as(fs.makeDirectory(given, { recursive: true }), given),
	});

	const bin = yield* fs.makeTempDirectoryScoped({ prefix: "phi-router-bin-" });
	const tokens = { first: login.token(first.expires, "first"), renewed: login.token(renewedUntil, "renewed") };

	const script = Array.join(
		[
			"#!/bin/sh",
			`printf 'run\\n' >> '${path.join(bin, "runs.log")}'`,
			first.standInRuns ?? "",
			...login.renews(login.text(tokens.renewed, renewedUntil, first.ends)),
			"",
		],
		"\n",
	);

	yield* fs.writeFileString(path.join(folder, login.file), login.text(tokens.first, first.expires, first.ends));
	yield* fs.writeFileString(path.join(bin, login.standIn), script, { mode: executable });

	return { bin, folder, ran: Effect.orElseSucceed(fs.readFileString(path.join(bin, "runs.log")), () => ""), tokens };
});

export { dayLong, day, loggedIn, logins, start, thirtyDays };

export type { Lifetime, Vendor };
