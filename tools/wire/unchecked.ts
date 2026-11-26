import { Array, Context, Effect, FileSystem, Layer, Path, String as Str, pipe } from "effect";
import { FetchHttpClient, HttpClient, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import type { PinnedTurn, Rewritten } from "./answer-checks.ts";
import type { Check } from "./checks.ts";
import { NodeHttpServer } from "@effect/platform-node";
import { planAnswers } from "./answer-checks.ts";
import { pluginCopy } from "#tools/plugin/copied.ts";

type Fault = "no router" | "a 500" | "an unreadable body";

const serverError = 500;

const answerCheckPath = "/phi-router/answer-check";

const faultyAnswer = (fault: Exclude<Fault, "no router">): HttpServerResponse.HttpServerResponse => {
	if (fault === "a 500") {
		return HttpServerResponse.text("router failure", { status: serverError });
	}

	return HttpServerResponse.text("not the contract's json", { contentType: "application/json" });
};

const faultyRouter = Effect.fnUntraced(function* faultyRouter(router: string, fault: Exclude<Fault, "no router">) {
	const built = yield* Layer.build(Layer.merge(NodeHttpServer.layerTest, FetchHttpClient.layer));
	const server = Context.get(built, HttpServer.HttpServer);
	const client = Context.get(built, HttpClient.HttpClient);

	const answer = Effect.gen(function* answer() {
		const request = yield* HttpServerRequest.HttpServerRequest;

		if (Str.startsWith(answerCheckPath)(request.url)) {
			return faultyAnswer(fault);
		}

		const forwarded = yield* client.get(`${router}${request.url}`);
		const text = yield* forwarded.text;

		return HttpServerResponse.text(text, { contentType: "application/json", status: forwarded.status });
	});

	yield* server.serve(Effect.orDie(answer));

	return HttpServer.formatAddress(server.address);
});

const closedPort = "http://127.0.0.1:9";

const answerCheckAddress = String.raw`answer-check --address \"$ANTHROPIC_BASE_URL\"`;

const answerChecksAt = Effect.fnUntraced(function* answerChecksAt(address: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const plugin = yield* pluginCopy;
	const file = path.join(plugin, "hooks", "hooks.json");
	const hooks = yield* fs.readFileString(file);

	const addressed = Str.replaceAll(answerCheckAddress, String.raw`answer-check --address \"${address}\"`)(hooks);

	yield* fs.writeFileString(file, addressed);

	return plugin;
});

const uncheckedPlugins = Effect.fnUntraced(function* uncheckedPlugins(router: string) {
	const failing = yield* faultyRouter(router, "a 500");
	const unreadable = yield* faultyRouter(router, "an unreadable body");

	const failingAt = yield* answerChecksAt(failing);
	const noRouter = yield* answerChecksAt(closedPort);
	const unreadableAt = yield* answerChecksAt(unreadable);

	return { failing: failingAt, noRouter, unreadable: unreadableAt };
});

const uncheckedLine = "phi-router could not check the pinned subagent's answer, so it withheld it";

const opened = (turns: readonly PinnedTurn[]): readonly string[] =>
	pipe(
		turns,
		Array.flatMap(({ open }) => open),
		Array.map(({ body }) => body),
	);

const opensAny =
	(texts: readonly string[]) =>
	(turns: readonly PinnedTurn[]): boolean =>
		pipe(
			opened(turns),
			Array.some((body) =>
				pipe(
					texts,
					Array.some((text) => Str.includes(text)(body)),
				),
			),
		);

const withheldUnchecked =
	(answer: string) =>
	(turn: PinnedTurn): boolean => {
		const handedBack = pipe(opened([turn]), Array.filter(Str.includes(uncheckedLine)));

		return Array.isReadonlyArrayNonEmpty(handedBack) && !opensAny([answer])([turn]);
	};

const uncheckedChecksOf = (played: Rewritten): readonly Check[] => [
	{
		name: "a pinned subagent's answer that no router, a 500 or an unreadable body kept from its check reaches the root agent as the could-not-check line, and the open mock never gets the answer",
		ok:
			withheldUnchecked(planAnswers.noRouter)(played.noRouter) &&
			withheldUnchecked(planAnswers.failing)(played.failing) &&
			withheldUnchecked(planAnswers.unreadable)(played.unreadable) &&
			!opensAny([planAnswers.noRouter, planAnswers.failing, planAnswers.unreadable])(played.all),
	},
	{
		name: "a background pinned subagent's cleared answer reaches the root agent in its notification, and another subagent's background answer does too",
		ok:
			opensAny([planAnswers.inBackground])([played.inBackground]) &&
			opensAny([planAnswers.otherInBackground])([played.otherInBackground]),
	},
	{
		name: "a background pinned subagent's answer that a 500 kept from its check never reaches the root agent, and the user sees the could-not-check line",
		ok:
			Str.includes("operation blocked by hook")(played.failingInBackground.printed) &&
			Str.includes(uncheckedLine)(played.failingInBackground.printed) &&
			!opensAny([planAnswers.failingInBackground])(played.all),
	},
];

export { uncheckedChecksOf, uncheckedPlugins };
