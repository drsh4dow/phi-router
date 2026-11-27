let line = null;

const windowsRoot = /^[A-Za-z]:[\\/]/u;

const launched = async ($, root, args, env) => {
	if (!windowsRoot.test(root)) {
		return $.process.run([`${root}/bin/phi-router`, ...args], { env });
	}

	const given = (await $.env.get("NO_PROXY")) ?? (await $.env.get("no_proxy")) ?? "";
	const exempted = given === "" ? "127.0.0.1" : `127.0.0.1,${given}`;
	const launcher = { ...env, NO_PROXY: exempted, PHI_ROUTER_GIVEN_NO_PROXY: given, PHI_ROUTER_LAUNCHED: "1" };
	const argv = [`${root}/phi-router.mjs`, ...args];

	try {
		return await $.process.run(["bun", ...argv], { env: launcher });
	} catch {
		return $.process.run(["node", ...argv], { env: launcher });
	}
};

const shown = async ($, words) => {
	const env = await $.process.hookEnv();
	const address = (await $.env.get("ANTHROPIC_BASE_URL")) ?? "";
	const session = await $.session.id();
	const args = ["statusline", "--address", address, "--session", session, "--words", words];
	const ran = await launched($, env.CLAUDE_PLUGIN_ROOT, args, env);

	return JSON.parse(ran.stdout);
};

const refresh = async ($) => {
	try {
		line = (await shown($, "")).line ?? null;
	} catch {
		line = null;
	}

	$.ui.invalidate("ui.render");
};

export function register(on) {
	on("session.start", async ($, e, next) => {
		const started = await next(e);

		await refresh($);

		return started;
	});

	on("turn.complete", async ($, e, next) => {
		const completed = await next(e);

		await refresh($);

		return completed;
	});

	on("command.run", { command: "phi-router:phi" }, async ($, e) => {
		try {
			return { isTextDisplayOnly: true, text: (await shown($, e.args)).reply };
		} catch (error) {
			return { isTextDisplayOnly: true, text: `could not read this session's status: ${String(error)}` };
		}
	});

	on("ui.render", { component: "StatusLine" }, async ($, e, next) => {
		if (line === null) {
			return next(e);
		}

		const text = e.props.text ? `${e.props.text}\n${line}` : line;

		return next({ ...e, props: { ...e.props, text } });
	});
}
