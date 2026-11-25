import { Array, Effect, Exit, FileSystem, Layer, Path, String as Str, Struct, pipe } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { appendPrivately, writePrivately } from "#router/client/private-file.ts";
import { assert, it } from "@effect/vitest";
import { bodyOf, claudeRequest, mocked } from "./mocked-router.ts";
import { NodeServices } from "@effect/platform-node";
import { privacyUnder } from "./private.ts";
import { routerProcess } from "./router-process.ts";

const canary = "PATIENT-CANARY-7Q4K";

const patient = { timeout: 60_000 };

const session = "s1";

const sessionInBase64Url = "czE";

const writtenOnLeaseAndCanaryRequest = [
	"/phi-router",
	"/phi-router/leases.json",
	"/phi-router/lanes.jsonl",
	`/phi-router/sessions/${sessionInBase64Url}.json`,
];

const routerUnderNoUmask = ["/bin/sh", "-c", 'umask 000 && exec bun src/router/main.ts "$@"', "sh"] as const;

const canaryThrough = Effect.fnUntraced(function* canaryThrough(url: string) {
	const client = yield* HttpClient.HttpClient;
	const body = yield* bodyOf([{ role: "user", text: `Member ${canary} called.` }]);
	const answer = yield* client.execute(HttpClientRequest.prependUrl(url)(claudeRequest({ body, session })));

	return yield* answer.text;
});

const leftPrivate = Effect.gen(function* leftPrivate() {
	const { env, mocks, roots } = yield* mocked({ holdsPhi: Str.includes(canary) });
	const router = yield* routerProcess(routerUnderNoUmask, env);

	yield* canaryThrough(router.url);

	const opened = yield* mocks.open.received;
	const { notPrivate, shown } = yield* privacyUnder(roots);

	const seen = pipe(
		writtenOnLeaseAndCanaryRequest,
		Array.filter((tail) =>
			pipe(
				shown,
				Array.some((line) => Str.includes(`${tail} `)(line)),
			),
		),
	);

	assert.deepStrictEqual(
		{ notPrivate, opened: opened.length, seen },
		{ notPrivate: [], opened: 1, seen: writtenOnLeaseAndCanaryRequest },
	);
});

const cutBeforeRename = Effect.gen(function* cutBeforeRename() {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const folder = yield* fs.makeTempDirectoryScoped({ prefix: "phi-router-rename-" });
	const file = path.join(folder, "store.json");
	const crashing = Struct.assign(fs, { rename: () => Effect.die("the router stopped before its rename") });

	yield* fs.writeFileString(file, "old");

	const cut = yield* writePrivately(file, "new").pipe(
		Effect.provideService(FileSystem.FileSystem, crashing),
		Effect.exit,
	);

	const left = yield* fs.readFileString(file);

	assert.deepStrictEqual({ cut: Exit.isFailure(cut), left }, { cut: true, left: "old" });
});

const appendedFirst = Effect.gen(function* appendedFirst() {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const root = yield* fs.makeTempDirectoryScoped({ prefix: "phi-router-append-" });

	yield* appendPrivately(path.join(root, "phi-router", "lanes.jsonl"), "line\n");

	const { notPrivate, shown } = yield* privacyUnder([root]);

	assert.deepStrictEqual({ notPrivate, seen: shown.length }, { notPrivate: [], seen: 2 });
});

it.layer(Layer.merge(NodeServices.layer, FetchHttpClient.layer))("the router's files", (test) => {
	test.effect(
		"after a lease and one canary request of the router run under Bun with no umask, are 0700 for each folder and 0600 for each file under the XDG state and config folders",
		() => leftPrivate,
		patient,
	);
	test.effect("a write cut off before its rename leaves the old file whole", () => cutBeforeRename);
	test.effect(
		"the first append to a file in a folder that does not exist yet makes it 0600 in 0700",
		() => appendedFirst,
	);
});
