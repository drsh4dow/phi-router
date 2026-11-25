const setupRun = (harness: string): string => {
	if (harness === "pi") {
		return "Type /phi setup.";
	}

	return `Run in a terminal: npx phi-router setup ${harness}`;
};

const stopped = {
	baaKeyRefused: (harness: string): string =>
		`phi-router stopped this message. Your BAA account refused its key, so nothing was sent, and nothing reached your subscription. Run in a terminal: npx phi-router setup ${harness} --new-key`,
	noBaaKey: (harness: string): string =>
		`phi-router stopped this message. It is missing your BAA key or the OpenAI key for its PHI check. Nothing left your computer. ${setupRun(harness)}`,
	notStarted: (harness: string): string =>
		`phi-router could not start, so this message was not sent. Nothing left your computer. Send it again. If it repeats, run: npx phi-router doctor ${harness}`,
} as const;

export { stopped };
