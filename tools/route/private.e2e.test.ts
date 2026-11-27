import { Array, Effect, Exit, FileSystem, Layer, Order, Path, String as Str, Struct, pipe } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { appendPrivately, daclOf, isPrivateDacl, userSid, writePrivately } from "#router/client/private-file.ts";
import { assert, it } from "@effect/vitest";
import { bodyOf, claudeRequest, mocked } from "./mocked-router.ts";
import { grantedToEveryone, privacyUnder } from "./private.ts";
import { NodeServices } from "@effect/platform-node";
import { callerHeader } from "#router/client/router-port/index.ts";
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

const routersUnderNoUmask: Readonly<Partial<Record<NodeJS.Platform, readonly [string, ...string[]]>>> = {
	win32: ["bun", "src/router/main.ts"],
};

const routerUnderNoUmask = routersUnderNoUmask[process.platform] ?? [
	"/bin/sh",
	"-c",
	'umask 000 && exec bun src/router/main.ts "$@"',
	"sh",
];

const onWindows = process.platform === "win32";

const callerHeadersIn = Effect.fnUntraced(function* callerHeadersIn(state: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;

	if (!onWindows) {
		return {};
	}

	const token = yield* fs.readFileString(path.join(state, "caller-token"));

	return { [callerHeader]: token };
});

const canaryThrough = Effect.fnUntraced(function* canaryThrough(
	url: string,
	headers: Readonly<Record<string, string>>,
) {
	const client = yield* HttpClient.HttpClient;
	const body = yield* bodyOf([{ role: "user", text: `Member ${canary} called.` }]);

	const sent = HttpClientRequest.setHeaders(
		HttpClientRequest.prependUrl(url)(claudeRequest({ body, session })),
		headers,
	);

	const answer = yield* client.execute(sent);
	const text = yield* answer.text;

	return { status: answer.status, text };
});

const leftPrivate = Effect.gen(function* leftPrivate() {
	const { env, mocks, roots, state } = yield* mocked({ holdsPhi: Str.includes(canary) });
	const router = yield* routerProcess(routerUnderNoUmask, env);
	const headers = yield* callerHeadersIn(state);

	yield* canaryThrough(router.url, headers);

	const opened = yield* mocks.open.received;
	const { notPrivate, shown } = yield* privacyUnder(roots);

	const seen = pipe(
		writtenOnLeaseAndCanaryRequest,
		Array.filter((tail) =>
			pipe(
				shown,
				Array.some((line) => Str.includes(`${tail} `)(Str.replaceAll("\\", "/")(line))),
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

const forbidden = 403;

const wrongToken = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const tokenless = Effect.gen(function* tokenless() {
	const { env, mocks } = yield* mocked({ holdsPhi: () => false });
	const router = yield* routerProcess(routerUnderNoUmask, env);
	const bare = yield* canaryThrough(router.url, {});
	const wrong = yield* canaryThrough(router.url, { [callerHeader]: wrongToken });
	const opened = yield* mocks.open.received;
	const baa = yield* mocks.baa.received;

	assert.deepStrictEqual(
		{ bare: bare.status, reached: opened.length + baa.length, wrong: wrong.status },
		{ bare: forbidden, reached: 0, wrong: forbidden },
	);
});

const sealedOnWindows = Effect.gen(function* sealedOnWindows() {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const root = yield* fs.makeTempDirectoryScoped({ prefix: "phi-router-acl-" });
	const folder = path.join(root, "phi-router", "sealed");
	const file = path.join(folder, "czE.json");

	const outside = path.join(root, "outside.json");

	yield* writePrivately(file, canary);
	yield* writePrivately(outside, canary);

	const sid = yield* userSid(root);
	const named = [path.join(root, "phi-router"), folder, file, outside];
	const acls = yield* Effect.forEach(named, daclOf, { concurrency: 1 });
	const texts = yield* Effect.forEach([file, outside], (written) => fs.readFileString(written), { concurrency: 1 });

	const targets = ["folder", "inheritedFolder", "inheritedFile", "file"] as const;
	const privateAcls = Array.zipWith(targets, acls, (target, acl) => isPrivateDacl({ sid, target })(acl));

	assert.deepStrictEqual({ privateAcls, texts }, { privateAcls: [true, true, true, true], texts: [canary, canary] });
});

const missingTarget = "phi-router-no-such-file";

const icaclsRefusing = Effect.gen(function* icaclsRefusing() {
	const real = yield* ChildProcessSpawner.ChildProcessSpawner;

	return ChildProcessSpawner.make((command) => {
		if (ChildProcess.isStandardCommand(command) && Array.contains(command.args, "/inheritance:r")) {
			return real.spawn(ChildProcess.make(command.command, [missingTarget], { stdin: "ignore" }));
		}

		return real.spawn(command);
	});
});

const refusedOnWindows = Effect.gen(function* refusedOnWindows() {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const folder = yield* fs.makeTempDirectoryScoped({ prefix: "phi-router-refused-" });
	const refusing = yield* icaclsRefusing;

	const written = yield* writePrivately(path.join(folder, "czE.json"), canary).pipe(
		Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, refusing),
		Effect.exit,
	);

	const left = yield* fs.readDirectory(folder);

	assert.deepStrictEqual({ failed: Exit.isFailure(written), left }, { failed: true, left: [] });
});

const succeeded = 0;

const sharedOnWindows = Effect.gen(function* sharedOnWindows() {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const folder = yield* fs.makeTempDirectoryScoped({ prefix: "phi-router-shared-" });
	const log = path.join(folder, "lanes.jsonl");
	const store = path.join(folder, "store.json");

	yield* fs.writeFileString(log, "old\n");
	yield* fs.writeFileString(store, "old");

	const granted = [yield* grantedToEveryone(log), yield* grantedToEveryone(store)];

	assert.deepStrictEqual(pipe(granted, Array.map(Number)), [succeeded, succeeded]);

	const appended = yield* Effect.exit(appendPrivately(log, canary));
	const written = yield* Effect.exit(writePrivately(store, canary));
	const sid = yield* userSid(store);
	const storeAcl = yield* daclOf(store);
	const left = yield* fs.readDirectory(folder);
	const logText = yield* fs.readFileString(log);

	assert.deepStrictEqual(
		{
			appended: Exit.isFailure(appended),
			left: Array.sort(left, Order.String),
			logText,
			storeAcl: isPrivateDacl({ sid, target: "file" })(storeAcl),
			written: Exit.isSuccess(written),
		},
		{
			appended: true,
			left: ["lanes.jsonl", "store.json"],
			logText: "old\n",
			storeAcl: true,
			written: true,
		},
	);
});

it.layer(Layer.merge(NodeServices.layer, FetchHttpClient.layer))("the router's files", (test) => {
	test.effect(
		"after a lease and one canary request of the router run under Bun with no umask, are 0700 for each folder and 0600 for each file under the XDG state and config folders",
		() => leftPrivate,
		patient,
	);
	test.effect("a write cut off before its rename leaves the old file whole", () => cutBeforeRename);
	test.effect(
		"the first append to a file in a folder that does not exist yet makes it 0600 in 0700, or on Windows grants only the current user",
		() => appendedFirst,
		patient,
	);
	test.effect.skipIf(!onWindows)(
		"on Windows, a private file grants only the current user: by inheritance in a folder it created private, and with no inherited entry in a folder that was already there",
		() => sealedOnWindows,
		patient,
	);
	test.effect.skipIf(!onWindows)(
		"on Windows, an append to a file another account may read fails and adds nothing, and a write replaces such a file with one only the current user may open",
		() => sharedOnWindows,
		patient,
	);
	test.effect.skipIf(!onWindows)(
		"on Windows, a model request without the caller token, or with a wrong one, is refused with 403 and reaches no account",
		() => tokenless,
		patient,
	);
	test.effect.skipIf(!onWindows)(
		"on Windows, a write whose ACL cannot be applied fails and leaves no file behind",
		() => refusedOnWindows,
		patient,
	);
});
