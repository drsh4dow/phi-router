let line = null;

const shown = async ($, words) => {
	const env = await $.process.hookEnv();
	const address = (await $.env.get("ANTHROPIC_BASE_URL")) ?? "";
	const session = await $.session.id();
	const argv = [`${env.CLAUDE_PLUGIN_ROOT}/bin/phi-router`, "statusline", "--address", address, "--session", session];
	const ran = await $.process.run([...argv, "--words", words], { env });

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
