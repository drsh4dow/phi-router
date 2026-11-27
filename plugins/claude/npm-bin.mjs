#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const bundle = fileURLToPath(new URL("phi-router.mjs", import.meta.url));

if (!existsSync(bundle)) {
	console.error("This copy of phi-router is not built. Run bun run build in it, or install a release.");
	process.exit(1);
}

const args = process.argv.slice(2);
const given = { NO_PROXY: process.env.NO_PROXY ?? "", no_proxy: process.env.no_proxy ?? "" };
const exempted = (list) => (list === "" ? "127.0.0.1" : `127.0.0.1,${list}`);

const env = {
	...process.env,
	NO_PROXY: exempted(given.NO_PROXY),
	PHI_ROUTER_GIVEN_NO_PROXY: given.NO_PROXY,
	PHI_ROUTER_GIVEN_no_proxy: given.no_proxy,
	PHI_ROUTER_LAUNCHED: "1",
	no_proxy: exempted(given.no_proxy),
};

if (args[0] === "doctor") {
	env.BUN_RUNTIME_TRANSPILER_CACHE_PATH = "0";
}

const relayed = ["SIGHUP", "SIGTERM"];

process.on("SIGINT", () => {});

const launched = (runtime) => {
	const child = spawn(runtime, [bundle, ...args], { env, stdio: "inherit" });

	for (const signal of relayed) {
		process.on(signal, () => child.kill(signal));
	}

	child.on("exit", (code, signal) => {
		if (signal === null) {
			process.exit(code);
		}

		process.removeAllListeners(signal);
		process.kill(process.pid, signal);
	});

	return child;
};

launched("bun").on("error", (error) => {
	if (error.code !== "ENOENT") {
		throw error;
	}

	launched(process.execPath);
});
