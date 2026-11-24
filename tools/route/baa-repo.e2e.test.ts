import { Array, Context, Effect, FileSystem, Layer, Path, pipe } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { LeaseRequests, SessionRequests } from "#router/client/router-port/index.ts";
import { assert, it } from "@effect/vitest";
import { bodyOf, claudeRequest, fakes, laneLines, mocked } from "./mocked-router.ts";
import { NodeServices } from "@effect/platform-node";
import { routerProcess } from "./router-process.ts";

/**
 * Under a fresh real folder: `clinic/app` and `Clinic/app`, `clinic-link` to `clinic`, `ward/app/src`, `ward-other/app`,
 * `ward/escape` to `ward-other/app`, `ward-other/inlet` to `ward/app/src`, `ledger/books`, `annex/ledger-link` to
 * `ledger/books`, and `buried` to `ward-other/inlet/..`, which is really `ward/app`. Returns the repositories to list, and by session the folder to lease and the account its request must
 * reach. Each folder differs from a listed repository's real path in one way: its case, a trailing slash, a `.` or `..`
 * segment, a symlink, or a shared prefix.
 */
const repositories = Effect.gen(function* repositories() {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const made = yield* fs.makeTempDirectoryScoped({ prefix: "phi-router-repos-" });
	const root = yield* fs.realPath(made);
	const under = (name: string): string => path.join(root, name);

	yield* Effect.forEach(
		["clinic/app", "Clinic/app", "ward/app/src", "ward-other/app", "ledger/books", "annex"],
		(name) => fs.makeDirectory(under(name), { recursive: true }),
		{ concurrency: 1 },
	);
	yield* Effect.forEach(
		[
			[under("clinic"), "clinic-link"],
			[under("ward-other/app"), "ward/escape"],
			[under("ward/app/src"), "ward-other/inlet"],
			[under("ledger/books"), "annex/ledger-link"],
			[`${under("ward-other")}/inlet/..`, "buried"],
		] as const,
		([target, link]) => fs.symlink(target, under(link)),
		{ concurrency: 1 },
	);

	const folders: readonly { readonly session: string; readonly folder: string; readonly reaches: "baa" | "open" }[] = [
		{ folder: under("clinic/app"), reaches: "baa", session: "real" },
		{ folder: path.relative(path.resolve("."), under("clinic/app")), reaches: "baa", session: "relative" },
		{ folder: under("Clinic/app"), reaches: "open", session: "other-case" },
		{ folder: path.join(under("clinic-link"), "app"), reaches: "baa", session: "symlink" },
		{ folder: `${under("ward")}/app/`, reaches: "baa", session: "trailing-slash" },
		{ folder: `${under("ward")}/app/./src`, reaches: "baa", session: "dotted" },
		{ folder: `${under("ward")}/escape/.`, reaches: "open", session: "dotted-link" },
		{ folder: `${under("ward-other")}/../ward/app`, reaches: "baa", session: "dot-dot-in" },
		{ folder: `${under("ward")}/../ward-other/app`, reaches: "open", session: "dot-dot-out" },
		{ folder: `${under("ward")}/escape/..`, reaches: "open", session: "dot-dot-link-out" },
		{ folder: `${under("ward-other")}/inlet/..`, reaches: "baa", session: "dot-dot-link-in" },
		{ folder: under("buried"), reaches: "baa", session: "hidden-dot-dot" },
		{ folder: under("ward"), reaches: "baa", session: "root" },
		{ folder: under("ledger/books"), reaches: "baa", session: "listed-dot-dot-link" },
		{ folder: under("annex"), reaches: "open", session: "listed-dot-dot-link-spelling" },
		{ folder: under("ward-other/app"), reaches: "open", session: "sibling" },
		{ folder: root, reaches: "open", session: "above" },
	];

	return { folders, listed: [under("clinic-link"), `${under("ward")}/`, `${under("annex")}/ledger-link/..`] };
});

const leasedAndAsked = Effect.fnUntraced(function* leasedAndAsked(url: string, session: string, folder: string) {
	const built = yield* Layer.build(LeaseRequests.layer);
	const leases = Context.get(built, LeaseRequests);
	const client = yield* HttpClient.HttpClient;

	yield* leases.post(Number(new URL(url).port), { folder, pid: process.pid, session });

	const body = yield* bodyOf([{ role: "user", text: `Hello from ${session}.` }]);
	const response = yield* client.execute(HttpClientRequest.prependUrl(url)(claudeRequest({ body, session })));

	yield* response.text;
});

/**
 * The configuration lists `clinic` through its symlink, `ward/` with a trailing slash, and `annex/ledger-link/..`,
 * which is really `ledger`. Each session leases one folder of `repositories` and sends one request. A folder is held
 * when its real path is a listed repository's real path or below it: `Clinic` is another folder, `ward/escape/.` and
 * `ward/escape/..` are really under `ward-other` though spelled under `ward/`, and `ward-other/inlet/..` is really
 * `ward/app`. The router runs as its own process, so a relative folder it received would resolve against the router's
 * folder, not the session's.
 */
const spellings = Effect.gen(function* spellings() {
	const requests = yield* SessionRequests;
	const { folders, listed } = yield* repositories;
	const { env, mocks, state } = yield* mocked({ configExtras: { baaRepos: listed }, holdsPhi: () => false });
	const router = yield* routerProcess(["bun", "src/router/main.ts"], env);

	yield* Effect.forEach(folders, ({ folder, session }) => leasedAndAsked(router.url, session, folder), {
		concurrency: 1,
	});

	const judged = yield* mocks.judge.received;
	const lines = yield* laneLines(state);
	const status = yield* requests.status(Number(new URL(router.url).port), "real");

	assert.deepStrictEqual<unknown>(
		{
			judged: judged.length,
			lines: pipe(
				lines,
				Array.map((line) => [line.session, line.account]),
			),
			realLast: status.last,
			reasons: pipe(
				lines,
				Array.map((line) => line.reason),
				Array.dedupe,
			),
		},
		{
			judged: Array.countBy(folders, ({ reaches }) => reaches === "open"),
			lines: pipe(
				folders,
				Array.map(({ reaches, session }) => [session, reaches]),
			),
			realLast: { account: "baa", model: fakes.targetModel, substitute: false },
			reasons: ["BAA repo", "clean"],
		},
	);
});

it.layer(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer, SessionRequests.layer))("a BAA repo", (test) => {
	test.effect(
		"holds a session whose lease folder's real path is inside a listed repository, whatever its case, slash, dot or link, and no other",
		() => spellings,
		{ timeout: 60_000 },
	);
});
