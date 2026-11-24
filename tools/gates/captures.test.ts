import { Array, Effect, FileSystem, Path, String as Str, pipe } from "effect";
import { assert, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";

const credentialPatterns = [
	{ name: "a Bearer header value", pattern: /bearer\s+[\w.~+/=-]{8,}/iu },
	{ name: "a vendor key such as sk-ant- or sk-proj-", pattern: /sk-[a-z]+-[\w-]{16,}/iu },
	{ name: "a legacy OpenAI key, sk- and 32 or more letters and digits", pattern: /sk-[\dA-Za-z]{32,}/iu },
	{ name: "a GitHub token", pattern: /(?:gh[opsur]_|github_pat_)\w{30,}/iu },
	{ name: "a JWT", pattern: /eyJ[\w-]{8,}\.[\w-]{8,}/iu },
	{
		name: "an opaque token of 40 or more mixed letters and digits",
		pattern: /(?=(?:[\w+/=-]*?[\da-z][A-Z]){3})(?=[\w+/=-]*\d)[\w+/=-]{40,}/u,
	},
] as const;

interface CredentialHit {
	readonly length: number;
	readonly looksLike: string;
	readonly startsAt: number;
}

const credentialsIn = (text: string): readonly CredentialHit[] =>
	pipe(
		credentialPatterns,
		Array.flatMap(({ name, pattern }) => {
			const hit = pattern.exec(text);

			if (hit === null) {
				return [];
			}

			const [value] = hit;

			return [{ length: value.length, looksLike: name, startsAt: hit.index }];
		}),
	);

const tokenLength = 108;

const token = Str.padEnd(tokenLength, "aB3_x9Z-")("");

const body = (length: number): string => Str.padEnd(length, "aB3cD4eF5gH6")("");

const legacyKeyLength = 48;

const githubLength = 36;

const githubPatLength = 82;

const credentials = [
	`"key":"sk-ant-api03-${body(tokenLength)}"`,
	`"key":"sk-ant-oat01-${body(tokenLength)}"`,
	`"key":"sk-${body(legacyKeyLength)}"`,
	`"key":"sk-proj-${body(tokenLength)}"`,
	...pipe(
		["ghp_", "gho_", "ghu_", "ghs_", "ghr_"],
		Array.map((prefix) => `"token":"${prefix}${body(githubLength)}"`),
	),
	`"token":"github_pat_${body(githubPatLength)}"`,
	`eyJhbGciOiJSUzI1NiJ9.${body(tokenLength)}.${body(tokenLength)}`,
	`Authorization: Bearer ${body(tokenLength)}`,
];

const casesOf = (credential: string): readonly string[] => [
	credential,
	Str.toLowerCase(credential),
	Str.toUpperCase(credential),
];

const plantedIn = ["anthropic-messages/captures/tool-result.ts", "codex/captures/first-turn.request.ts"];

it.effect("the credential patterns catch each spelling of a token and pass the placeholders", () =>
	Effect.sync(() => {
		const placeholders = [
			String.raw`{\"device_id\":\"device-id-placeholder\",\"session_id\":\"session-id-placeholder\"}`,
			'"signature":"signature-placeholder"',
			'"id":"toolu_01QLmmERkcyuzj56mJxsGPcP"',
			'"id":"msg_011ChEz91dv3CsGCLeFzafD9"',
			"/tmp/phi-16/work/notes.txt",
			'"encrypted_content":"Opaque-Reasoning-Content-Placeholder-0001"',
			"Pass the returned token as Authorization: Bearer {site_access_token}.",
		];

		for (const spelling of [`"signature":"${token}"`, token]) {
			assert.isNotEmpty(credentialsIn(spelling), `not caught: a spelling of ${String(spelling.length)} characters`);
		}

		for (const placeholder of placeholders) {
			assert.deepStrictEqual(credentialsIn(placeholder), [], placeholder);
		}
	}),
);

it.layer(NodeServices.layer)("captured wire bytes", (test) => {
	test.effect("hold nothing that looks like a credential, in any captures folder under src/", () =>
		Effect.gen(function* scanned() {
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;
			const src = path.join(import.meta.dirname, "../../src");
			const files = yield* fs.readDirectory(src, { recursive: true });

			const captures = pipe(
				files,
				Array.filter((file) => Array.contains(Str.split(file, path.sep), "captures") && Str.endsWith(".ts")(file)),
			);

			assert.isNotEmpty(captures, "no captures folder found under src/");

			for (const file of captures) {
				const text = yield* fs.readFileString(path.join(src, file));

				assert.deepStrictEqual(credentialsIn(text), [], `src/${file} holds what looks like a credential`);
			}
		}),
	);

	test.effect(
		"catch each named credential, in lower, upper and mixed case, planted in a Claude and a Codex capture",
		() =>
			Effect.gen(function* plantedCredentials() {
				const fs = yield* FileSystem.FileSystem;
				const path = yield* Path.Path;

				for (const capture of plantedIn) {
					const text = yield* fs.readFileString(
						path.join(import.meta.dirname, "../../src/router/features", capture),
					);

					for (const spelling of pipe(credentials, Array.flatMap(casesOf))) {
						const planted = Str.replace('"', `"${spelling} `)(text);

						assert.isNotEmpty(
							credentialsIn(planted),
							`${capture} misses a spelling of ${String(spelling.length)} characters`,
						);
					}
				}
			}),
	);
});
