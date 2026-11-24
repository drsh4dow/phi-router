import { Array, Clock, Config, Effect, FileSystem, Layer, Path, String as Str, pipe } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { assert, it } from "@effect/vitest";
import { bodyOf, claudeRequest, mocked } from "./mocked-router.ts";
import { NodeServices } from "@effect/platform-node";
import type { Script } from "./harnesses.ts";
import { TestClock } from "effect/testing";
import { fakes } from "./harnesses.ts";
import { routerProcess } from "./router-process.ts";

const minute = 60_000;

const tenDays = 864_000_000;

const executable = 0o755;

const patient = { timeout: 60_000 };

const status = { failed: 500, ok: 200, unauthorized: 401 } as const;

const folderTokens = { first: "phi-test-printed-folder-first", renewed: "phi-test-printed-folder-renewed" } as const;

const credentials = [
	folderTokens.first,
	folderTokens.renewed,
	fakes.baaKey,
	fakes.harnessToken,
	fakes.judgeKey,
] as const;

const claudeFile = (token: string, expires: number): string =>
	`{"claudeAiOauth":{"accessToken":"${token}","expiresAt":${String(expires)},"refreshTokenExpiresAt":${String(expires + tenDays)}}}`;

/**
 * An account that answers its first request 401 and every later one 500, so a request is resent once, then fails over.
 *
 * @returns {Script} The account's script.
 */
const refusesThenFails = (): Script => {
	const asked: unknown[] = [];

	return (request) => {
		const first = Array.isReadonlyArrayEmpty(asked);

		asked.push(request);

		if (first) {
			return { body: "{}", kind: "status", status: status.unauthorized };
		}

		return { body: "{}", kind: "status", status: status.failed };
	};
};

const expiring = Effect.gen(function* expiring() {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const folder = yield* fs.makeTempDirectoryScoped({ prefix: "phi-router-login-" });
	const bin = yield* fs.makeTempDirectoryScoped({ prefix: "phi-router-bin-" });
	const searchPath = yield* Config.String("PATH");
	const now = yield* TestClock.withLive(Clock.currentTimeMillis);
	const renewed = claudeFile(folderTokens.renewed, now + tenDays);

	yield* fs.writeFileString(path.join(folder, ".credentials.json"), claudeFile(folderTokens.first, now + minute));
	yield* fs.writeFileString(
		path.join(bin, "claude"),
		`#!/bin/sh\nprintf 'run\\n' >> '${path.join(bin, "runs.log")}'\nprintf '%s' '${renewed}' > "$CLAUDE_CONFIG_DIR/.credentials.json"\n`,
		{ mode: executable },
	);

	return {
		env: { PATH: `${bin}:${searchPath}`, PHI_TEST_OUTPUT: path.join(bin, "router.log") },
		folder,
		printed: fs.readFileString(path.join(bin, "router.log")),
		runs: fs.readFileString(path.join(bin, "runs.log")),
	};
});

const holding = Effect.fnUntraced(function* holding(roots: readonly string[], printed: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;

	const listed = yield* Effect.forEach(roots, (root) => fs.readDirectory(root, { recursive: true }), {
		concurrency: 1,
	});

	const files = pipe(
		Array.zip(roots, listed),
		Array.flatMap(([root, names]) =>
			pipe(
				names,
				Array.map((name) => path.join(root, name)),
			),
		),
	);

	const texts = yield* Effect.forEach(
		files,
		(file) =>
			Effect.map(
				Effect.orElseSucceed(fs.readFileString(file), () => ""),
				(text) => ({ file, text }),
			),
		{ concurrency: 1 },
	);

	return pipe(
		[...texts, { file: "printed output", text: printed }],
		Array.filter(({ text }) =>
			pipe(
				credentials,
				Array.some((credential) => Str.includes(credential)(text)),
			),
		),
		Array.map(({ file }) => file),
	);
});

const teed = ["/bin/sh", "-c", 'bun src/router/main.ts "$@" 2>&1 | tee -a "$PHI_TEST_OUTPUT"', "sh"] as const;

const postedOnce = Effect.fnUntraced(function* postedOnce(env: Readonly<Record<string, string>>) {
	const client = yield* HttpClient.HttpClient;
	const router = yield* routerProcess(teed, env);
	const body = yield* bodyOf([{ role: "user", text: "List the build steps." }]);

	const answer = yield* client.execute(
		HttpClientRequest.prependUrl(router.url)(claudeRequest({ body, session: "s1" })),
	);

	yield* answer.text;

	return answer.status;
});

/**
 * One request runs the vendor CLI to refresh a token near expiry, gets a 401 and is resent after a second CLI run, gets
 * a 500 and fails over to a keyed BAA account. No fake credential shows in what the router printed, its warning
 * included, or in any file it wrote.
 */
const printsNoCredential = Effect.gen(function* printsNoCredential() {
	const login = yield* expiring;

	const { env, mocks, roots } = yield* mocked({
		env: login.env,
		holdsPhi: () => false,
		open: refusesThenFails(),
		openFolder: login.folder,
	});

	const answered = yield* postedOnce(env);
	const [opened = [], sealed = []] = yield* mocks.accounts;
	const printed = yield* login.printed;
	const leaked = yield* holding(roots, printed);

	assert.deepStrictEqual<unknown>(
		{
			answered,
			bearers: pipe(
				opened,
				Array.map(({ headers }) => headers["authorization"]),
			),
			leaked,
			noticed: Str.includes("token got a 401")(printed),
			runs: yield* login.runs,
			sealed: sealed.length,
		},
		{
			answered: status.ok,
			bearers: [`Bearer ${folderTokens.renewed}`, `Bearer ${folderTokens.renewed}`],
			leaked: [],
			noticed: true,
			runs: "run\nrun\n",
			sealed: 1,
		},
	);
});

const listening = Effect.gen(function* listening() {
	const { env } = yield* mocked({ holdsPhi: () => false });
	const router = yield* routerProcess(["bun", "src/router/main.ts"], env);

	assert.match(router.url, /^http:\/\/127\.0\.0\.1:\d+$/u);
});

it.layer(Layer.merge(NodeServices.layer, FetchHttpClient.layer))("what the router prints", (test) => {
	test.effect(
		"through a CLI refresh, a 401 resend and a failover to a keyed account, holds no credential, nor does any file it writes",
		() => printsNoCredential,
		patient,
	);
	test.effect(
		"says where it listens as http://127.0.0.1:<port>, the literal loopback address",
		() => listening,
		patient,
	);
});
