import { Array, Effect, Layer, String as Str, pipe } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { assert, it } from "@effect/vitest";
import { bodyOf, claudeRequest, mocked } from "./mocked-router.ts";
import { NodeServices } from "@effect/platform-node";
import { privacyUnder } from "./private.ts";
import { routerProcess } from "./router-process.ts";

const canary = "PATIENT-CANARY-7Q4K";

const patient = { timeout: 60_000 };

/** What the router writes on a lease and one sealed request of session `s1`, its id in base64url being `czE`. */
const written = ["/phi-router", "/phi-router/leases.json", "/phi-router/lanes.jsonl", "/phi-router/sessions/czE.json"];

/**
 * `bun src/router/main.ts` under umask 000, so a file or folder the router makes without its own mode shows as 0666 or
 * 0777 whatever the umask of the machine that runs `check`.
 */
const withNoUmask = ["/bin/sh", "-c", 'umask 000 && exec bun src/router/main.ts "$@"', "sh"] as const;

/** Posts one request of session `s1` that seals, as Claude Code sends it, to the router at `url`. */
const sealedThrough = Effect.fnUntraced(function* sealedThrough(url: string) {
	const client = yield* HttpClient.HttpClient;
	const body = yield* bodyOf([{ role: "user", text: `Member ${canary} called.` }]);
	const answer = yield* client.execute(HttpClientRequest.prependUrl(url)(claudeRequest({ body, session: "s1" })));

	return yield* answer.text;
});

/**
 * The router as its own process under Bun: `routerProcess` posts a lease, then one request seals. Every folder under the
 * XDG state and config folders is 0700 and every file 0600, and the walk saw each file the router writes.
 */
const leftPrivate = Effect.gen(function* leftPrivate() {
	const { env, mocks, roots } = yield* mocked({ holdsPhi: Str.includes(canary) });
	const router = yield* routerProcess(withNoUmask, env);

	yield* sealedThrough(router.url);

	const sealed = yield* mocks.baa.received;
	const { notPrivate, shown } = yield* privacyUnder(roots);

	const seen = pipe(
		written,
		Array.filter((tail) =>
			pipe(
				shown,
				Array.some((line) => Str.includes(`${tail} `)(line)),
			),
		),
	);

	assert.deepStrictEqual({ notPrivate, sealed: sealed.length, seen }, { notPrivate: [], sealed: 1, seen: written });
});

it.layer(Layer.merge(NodeServices.layer, FetchHttpClient.layer))("the router's files", (test) => {
	test.effect(
		"every folder the router makes under the XDG state and config folders is 0700 and every file 0600",
		() => leftPrivate,
		patient,
	);
});
