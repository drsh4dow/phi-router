import { appendFileSync } from "node:fs";

const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch(request) {
		const vendor = request.headers.has("x-api-key") ? "anthropic" : "openai";
		const sent = `${request.headers.get("x-api-key") ?? ""}${request.headers.get("authorization") ?? ""}`;
		appendFileSync(
			process.argv[2] ?? "key-checks.log",
			`${request.method} ${new URL(request.url).pathname} ${vendor} canary=${sent.includes("PHI-KEY-CANARY")}\n`,
		);
		return Response.json({ data: [] });
	},
});

console.log(server.url.origin);
