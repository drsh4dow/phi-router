import {
	Array,
	ConfigProvider,
	Context,
	Effect,
	FileSystem,
	Layer,
	Path,
	PlatformError,
	Record,
	Ref,
	Struct,
} from "effect";
import { Callers, Proofs, SessionRequests, callerHeader, listensOn, serve } from "#router/client/router-port/index.ts";
import { HttpClient, HttpClientRequest } from "effect/http";
import { NodeHttpServer, NodeServices } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { ChildProcessSpawner } from "effect/process";
import type { Path as Row } from "#router/client/router-port/index.ts";

const token = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const otherToken = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

const secret = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

const status = { forbidden: 403, ok: 200 } as const;

const paths = {
	hello: "/api/hello",
	messages: "/v1/messages",
	proof: "/phi-router/proof",
	status: "/phi-router/status",
} as const;

const windowsPathOf = Path.Path.pipe(Effect.map((posix) => Path.make(Struct.assign(posix, { sep: "\\" }))));

const windowsPath = Layer.effect(Path.Path, windowsPathOf).pipe(Layer.provide(Path.layer));

const noListing = Layer.succeed(
	ChildProcessSpawner.ChildProcessSpawner,
	ChildProcessSpawner.make(() => Effect.die("the token check lists no process")),
);

type Stored = "token" | "unreadable";

const filesHolding = (stored: Stored): Layer.Layer<FileSystem.FileSystem> =>
	FileSystem.layerNoop({
		exists: () => Effect.succeed(false),
		readFileString: () => {
			if (stored === "token") {
				return Effect.succeed(token);
			}

			return Effect.fail(PlatformError.badArgument({ description: "denied", method: "read", module: "FileSystem" }));
		},
	});

const platforms = { linux: Path.layer, windows: windowsPath } as const;

const tokenFineWith = Effect.fnUntraced(function* tokenFineWith(asked: {
	readonly stored: Stored;
	readonly presented: string;
	readonly platform: keyof typeof platforms;
}) {
	const callers = Callers.layer.pipe(
		Layer.provide([filesHolding(asked.stored), noListing, platforms[asked.platform]]),
	);

	const built = yield* Layer.build(callers);

	return yield* Context.get(built, Callers).tokenFine(asked.presented);
});

const tokenChecks = Effect.gen(function* tokenChecks() {
	const answered = yield* Effect.all(
		{
			linuxWithout: tokenFineWith({ platform: "linux", presented: "", stored: "unreadable" }),
			missing: tokenFineWith({ platform: "windows", presented: "", stored: "token" }),
			right: tokenFineWith({ platform: "windows", presented: token, stored: "token" }),
			unreadableFile: tokenFineWith({ platform: "windows", presented: token, stored: "unreadable" }),
			wrong: tokenFineWith({ platform: "windows", presented: otherToken, stored: "token" }),
		},
		{ concurrency: 1 },
	);

	assert.deepStrictEqual(answered, {
		linuxWithout: true,
		missing: false,
		right: true,
		unreadableFile: false,
		wrong: false,
	});
});

const answering = (method: Row["method"], path: Row["path"]): Row => ({
	answer: () => Effect.succeed({ body: "{}", kind: "whole", status: status.ok }),
	method,
	path,
});

interface Asked {
	readonly to: "hello" | "proof" | "messages";
	readonly sent: "noToken" | "token" | "otherToken";
	readonly owner: "thisUser" | "anotherUser";
}

const requestOf = ({ to, sent }: Asked): HttpClientRequest.HttpClientRequest => {
	const request = {
		hello: HttpClientRequest.get(paths.hello),
		messages: HttpClientRequest.post(paths.messages),
		proof: HttpClientRequest.get(paths.proof, { urlParams: { nonce: secret } }),
	}[to];

	if (sent === "noToken") {
		return request;
	}

	return HttpClientRequest.setHeader(request, callerHeader, { otherToken, token }[sent]);
};

const statusFor = Effect.fnUntraced(function* statusFor(asked: Asked) {
	const server = yield* Layer.build(NodeHttpServer.layerTest);

	const callers = Callers.of({
		isThisUser: () => Effect.succeed(asked.owner === "thisUser"),
		tokenFine: (presented) => Effect.succeed(presented === token),
	});

	const rows = [answering("GET", paths.hello), answering("GET", paths.proof), answering("POST", paths.messages)];
	const checked = Layer.succeed(Callers, callers);
	const listened = Layer.succeedContext(server);

	yield* Layer.build(serve(rows).pipe(Layer.provide(checked), Layer.provide(listened)));

	const response = yield* Context.get(server, HttpClient.HttpClient).execute(requestOf(asked));

	return response.status;
}, Effect.scoped);

const exemptions = Effect.gen(function* exemptions() {
	const answered = yield* Effect.all(
		{
			helloToAnotherUser: statusFor({ owner: "anotherUser", sent: "noToken", to: "hello" }),
			messagesWithToken: statusFor({ owner: "thisUser", sent: "token", to: "messages" }),
			messagesWithWrongToken: statusFor({ owner: "thisUser", sent: "otherToken", to: "messages" }),
			messagesWithoutToken: statusFor({ owner: "thisUser", sent: "noToken", to: "messages" }),
			proofToAnotherUser: statusFor({ owner: "anotherUser", sent: "noToken", to: "proof" }),
			proofWithoutToken: statusFor({ owner: "thisUser", sent: "noToken", to: "proof" }),
		},
		{ concurrency: 1 },
	);

	assert.deepStrictEqual(answered, {
		helloToAnotherUser: status.ok,
		messagesWithToken: status.ok,
		messagesWithWrongToken: status.forbidden,
		messagesWithoutToken: status.forbidden,
		proofToAnotherUser: status.forbidden,
		proofWithoutToken: status.ok,
	});
});

const admitsAll = Layer.succeed(
	Callers,
	Callers.of({ isThisUser: () => Effect.succeed(true), tokenFine: () => Effect.succeed(true) }),
);

const listening = Effect.fnUntraced(function* listening(rowsFor: (port: number) => Effect.Effect<readonly Row[]>) {
	const server = yield* Layer.build(NodeHttpServer.layerTest);
	const url = yield* Effect.provideContext(listensOn, server);
	const port = Number(new URL(url).port);
	const rows = yield* rowsFor(port);

	const listened = Layer.succeedContext(server);

	yield* Layer.build(serve(rows).pipe(Layer.provide(admitsAll), Layer.provide(listened)));

	return port;
});

const recordedIn =
	(heard: (line: string) => Effect.Effect<void>, path: Row["path"], body: string): Row["answer"] =>
	({ headers }) =>
		Effect.as(heard(`${path} ${headers[callerHeader] ?? "none"}`), { body, kind: "whole", status: status.ok });

const sentTo = Effect.gen(function* sentTo() {
	const routerHeard = yield* Ref.make<readonly string[]>([]);
	const squatterHeard = yield* Ref.make<readonly string[]>([]);
	const toRouter = (line: string): Effect.Effect<void> => Ref.update(routerHeard, Array.append(line));
	const toSquatter = (line: string): Effect.Effect<void> => Ref.update(squatterHeard, Array.append(line));
	const proven = yield* Layer.build(Layer.fresh(Proofs.layer));
	const proofs = Context.get(proven, Proofs);

	const router = yield* listening((port) =>
		Effect.map(Effect.orDie(proofs.row(port, "0.5.0")), (proof): readonly Row[] => [
			proof,
			{ answer: recordedIn(toRouter, paths.status, "{}"), method: "GET", path: paths.status },
		]),
	);

	const forged = `{"proof":"${secret}"}`;

	const squatter = yield* listening(() =>
		Effect.succeed([
			{ answer: recordedIn(toSquatter, paths.proof, forged), method: "GET", path: paths.proof },
			{ answer: recordedIn(toSquatter, paths.status, "{}"), method: "GET", path: paths.status },
		]),
	);

	const built = yield* Layer.build(Layer.provide(SessionRequests.layer, windowsPath));
	const requests = Context.get(built, SessionRequests);

	yield* Effect.ignore(requests.status(router, "s1"));
	yield* Effect.ignore(requests.status(squatter, "s1"));

	const heard = { router: yield* Ref.get(routerHeard), squatter: yield* Ref.get(squatterHeard) };

	assert.deepStrictEqual(heard, {
		router: [`${paths.status} ${token}`],
		squatter: [`${paths.proof} none`, `${paths.status} none`],
	});
});

const stateHolding = Effect.fnUntraced(function* stateHolding(files: Readonly<Record<string, string>>) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const state = yield* fs.makeTempDirectoryScoped();
	const folder = path.join(state, "phi-router");

	yield* fs.makeDirectory(folder);

	yield* Effect.forEach(Record.toEntries(files), ([name, text]) => fs.writeFileString(path.join(folder, name), text), {
		concurrency: 1,
	});

	return { config: ConfigProvider.fromEnv({ env: { XDG_STATE_HOME: state } }), folder };
});

const tokenSent = Effect.gen(function* tokenSent() {
	const { config } = yield* stateHolding({ "caller-token": token, secret });

	yield* Effect.provideService(sentTo, ConfigProvider.ConfigProvider, config);
});

it.layer(NodeServices.layer)("the caller token on Windows", (test) => {
	test.effect(
		"passes the stored token, and refuses a wrong or missing token or a token file the router cannot read; Linux asks for none",
		() => tokenChecks,
	);
	test.effect(
		"is asked of no caller of /api/hello or of the port proof, and of every caller of any other path; the proof still checks the owner",
		() => exemptions,
	);
	test.effect(
		"goes only to a listener that passed the port proof, never with the proof request, and never to another user's listener",
		() => Effect.scoped(tokenSent),
	);
});
