import { appendFileSync } from "node:fs";

const env = (name: string): string => process.env[name] ?? "";
const fakes = {
	baa: env("FAKE_BAA_KEY"),
	enterprise: env("FAKE_ENTERPRISE_TOKEN"),
	open: env("FAKE_OPEN_TOKEN"),
	openai: env("FAKE_OPENAI_KEY"),
};
const canary = env("CANARY");

type Json = any;
type Block = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: Json };

let uses = 0;
const text = (said: string): Block => ({ text: said, type: "text" });
const tool = (name: string, input: Json): Block => ({
	id: `toolu_setup_${String(++uses)}`,
	input,
	name,
	type: "tool_use",
});
const setup = (args: string): Block =>
	tool("Bash", {
		command: `npx phi-router setup claude ${args}`,
		description: "Run phi-router setup",
		timeout: 600000,
	});
const asJson = (answers: Json): string => `'${JSON.stringify(answers)}'`;
const stepCall = (answers: Json): Block =>
	setup(Object.keys(answers).length === 0 ? "--json" : `--json --answers ${asJson(answers)}`);
const applyCall = (answers: Json): Block => setup(`--apply --answers ${asJson(answers)}`);
const headers: Record<string, string> = {
	baa: "Patient data",
	enterprise: "Enterprise",
	everyday: "Everyday",
	judge: "PHI check",
};

const contentOf = (message: Json): Json[] =>
	typeof message?.content === "string" ? [text(message.content)] : (message?.content ?? []);
const outputOf = (result: Json): string =>
	typeof result.content === "string"
		? result.content
		: contentOf(result)
				.filter((c) => c.type === "text")
				.map((c) => c.text)
				.join("\n");
const toolUses = (messages: Json[]): Json[] =>
	messages.filter((m) => m.role === "assistant").flatMap((m) => contentOf(m).filter((c) => c.type === "tool_use"));
const setupCalls = (messages: Json[]): Json[] =>
	toolUses(messages).filter((u) => u.name === "Bash" && / phi-router setup claude /.test(u.input?.command ?? ""));
const answersIn = (command: string): Json => JSON.parse(/--answers '([^']*)'/.exec(command)?.[1] ?? "{}");
const answersSoFar = (messages: Json[]): Json => answersIn(setupCalls(messages).at(-1)?.input.command ?? "");
const stepIn = (output: string): Json =>
	output
		.split("\n")
		.flatMap((line) => {
			try {
				return [JSON.parse(line.trim())];
			} catch {
				return [];
			}
		})
		.findLast((step) => typeof step?.kind === "string");
const lastLine = (output: string): string =>
	output
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "" && !line.startsWith("<"))
		.at(-1) ?? "Setup printed nothing.";

const lastQuestion = (messages: Json[]): Json => {
	const results = messages.flatMap((m) => contentOf(m).filter((c) => c.type === "tool_result"));
	const asked = setupCalls(messages)
		.filter((u) => u.input.command.includes("--json"))
		.map((u) => stepIn(outputOf(results.find((r) => r.tool_use_id === u.id) ?? {})))
		.findLast((step) => step?.kind === "ask");
	return asked?.question;
};

const afterTool = (messages: Json[], result: Json): Block[] => {
	const use = toolUses(messages).find((u) => u.id === result.tool_use_id);
	const output = outputOf(result);
	const command: string = use?.input?.command ?? "";

	if (use?.name === "AskUserQuestion") {
		const question = lastQuestion(messages);
		const choice = question?.choices.find((c: Json) => output.includes(`="${c.label}"`));
		if (choice === undefined) return [text("Setup needs one of the listed choices.")];
		return [stepCall({ ...answersSoFar(messages), [question.id]: choice.id })];
	}

	if (command.includes("setup claude --apply")) return [text(lastLine(output))];

	if (command.includes("setup claude --json")) {
		const step = stepIn(output);
		if (step?.kind === "ask") {
			const options = step.question.choices.map((c: Json) => ({ description: "", label: c.label }));
			const header = headers[step.question.id] ?? "Setup";
			return [
				tool("AskUserQuestion", {
					questions: [{ header, multiSelect: false, options, question: step.question.text }],
				}),
			];
		}
		if (step?.kind === "stop") return [text(step.line)];
		if (step?.kind === "ready") return [applyCall(answersIn(command))];
		return [text("Setup printed no step.")];
	}

	return [text("done")];
};

const agentTurn = (body: Json): Block[] => {
	if (JSON.stringify(body.system ?? "").includes("You are a security monitor")) return [text("<block>no</block>")];
	if (!(body.tools ?? []).some((t: Json) => t.name === "Bash")) return [text("ok")];
	const messages: Json[] = (body.messages ?? []).filter((m: Json) => m.role !== "system");
	const last = messages.at(-1);
	if (last?.role !== "user") return [text("ok")];
	const content = contentOf(last);
	const result = content.find((c) => c.type === "tool_result");
	if (result !== undefined) return afterTool(messages, result);

	const typed = content
		.filter((c) => c.type === "text" && !c.text.trimStart().startsWith("<"))
		.map((c) => c.text)
		.join("\n")
		.trim();
	if (typed.includes("SETUP.md")) return [text("Checking what you have. Keys never show up here."), stepCall({})];
	if (typed === "done") return [applyCall(answersSoFar(messages))];
	return [text("ok")];
};

const message = (blocks: Block[], model: string): Json => ({
	content: blocks,
	id: `msg_setup_${String(++uses)}`,
	model,
	role: "assistant",
	stop_reason: blocks.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn",
	stop_sequence: null,
	type: "message",
	usage: { input_tokens: 1, output_tokens: 1 },
});

const streamed = (whole: Json): Response => {
	const events: string[] = [];
	const send = (type: string, data: Json): number =>
		events.push(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
	send("message_start", { message: { ...whole, content: [], stop_reason: null } });
	whole.content.forEach((block: Block, index: number) => {
		if (block.type === "text") {
			send("content_block_start", { content_block: { text: "", type: "text" }, index });
			send("content_block_delta", { delta: { text: block.text, type: "text_delta" }, index });
		} else {
			send("content_block_start", { content_block: { ...block, input: {} }, index });
			send("content_block_delta", {
				delta: { partial_json: JSON.stringify(block.input), type: "input_json_delta" },
				index,
			});
		}
		send("content_block_stop", { index });
	});
	send("message_delta", {
		delta: { stop_reason: whole.stop_reason, stop_sequence: null },
		usage: { output_tokens: 1 },
	});
	send("message_stop", {});
	return new Response(events.join(""), { headers: { "content-type": "text/event-stream" } });
};

const replied = (body: Json, blocks: Block[]): Response => {
	const whole = message(blocks, body.model ?? "claude-mock");
	return body.stream ? streamed(whole) : Response.json(whole);
};

const decision = (holdsPhi: boolean): Json => ({
	answers: [
		{ name: "identifier", probability: Number(holdsPhi), type: "predicate" },
		{ choice: "none", confidence: 1, name: "kind", probabilities: [], type: "choice" },
	],
	usage: { input_tokens: 1 },
});

const whoOf = (host: string, request: Request): string => {
	const bearer = (request.headers.get("authorization") ?? "").replace(/^Bearer /, "");
	const apiKey = request.headers.get("x-api-key") ?? "";
	if (host === "api.anthropic.com" && bearer !== "" && bearer === fakes.open) return "open";
	if (host === "api.anthropic.com" && apiKey !== "" && apiKey === fakes.baa) return "baa";
	if (host === "api.anthropic.com" && bearer !== "" && bearer === fakes.enterprise) return "baa";
	if (host === "api.openai.com" && bearer !== "" && bearer === fakes.openai) return "openai";
	return "unknown";
};

const answer = (host: string, path: string, who: string, request: Request, body: Json): [Response, string] => {
	if (request.method === "HEAD") return [new Response(null), "head"];
	if (path === "/v1/models") {
		const accepted = (host === "api.anthropic.com" && (who === "baa" || who === "open")) || who === "openai";
		return accepted
			? [Response.json({ data: [], has_more: false, object: "list" }), "models"]
			: [new Response("", { status: 401 }), "models refused"];
	}
	if (path === "/v1/messages/count_tokens") return [Response.json({ input_tokens: 1 }), "count"];
	if (path === "/v1/messages" && who === "open") {
		const blocks = agentTurn(body);
		const did = blocks.map((b) =>
			b.type === "text"
				? "text"
				: `${b.name}${b.name === "Bash" ? `:${/--(json|apply)/.exec(b.input.command)?.[0] ?? "other"}` : ""}`,
		);
		return [replied(body, blocks), did.join("+")];
	}
	if (path === "/v1/messages" && who === "baa") return [replied(body, [text("ok from the BAA account")]), "text"];
	if (path === "/v1/decisions" && who === "openai")
		return [Response.json(decision(JSON.stringify(body).includes(canary))), "decision"];
	if (who === "unknown" && (path === "/v1/messages" || path === "/v1/decisions"))
		return [new Response("", { status: 401 }), "refused"];
	return [new Response("", { status: 404 }), "unknown path"];
};

const server = Bun.serve({
	async fetch(request) {
		const url = new URL(request.url);
		const host = (request.headers.get("host") ?? url.hostname).replace(/:443$/, "");
		const raw = await request.text();
		let body: Json = {};
		try {
			body = JSON.parse(raw || "{}");
		} catch {}
		const who = whoOf(host, request);
		if (env("MOCK_BODIES") !== "" && url.pathname === "/v1/messages")
			Bun.write(`${env("MOCK_BODIES")}/${String(Date.now())}-${who}.json`, raw);
		const [response, did] = answer(host, url.pathname, who, request, body);
		const holdsKey = Object.values(fakes).some((fake) => fake !== "" && raw.includes(fake));
		appendFileSync(
			env("MOCK_LOG"),
			`${JSON.stringify({ did, holdsCanary: raw.includes(canary), holdsKey, host, method: request.method, path: url.pathname, status: response.status, t: Date.now(), who })}\n`,
		);
		return response;
	},
	hostname: "127.0.0.1",
	port: 443,
	tls: { cert: Bun.file(env("MOCK_CERT")), key: Bun.file(env("MOCK_CERT_KEY")) },
});

console.log(`listening ${server.url}`);
