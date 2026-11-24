import type { Harness } from "#router/features/border/index.ts";

type Stop = "noBaaKey" | "baaKeyRefused" | "notStarted";

const stopLines: Readonly<Record<Stop, (harness: Harness) => string>> = {
	baaKeyRefused: (harness) =>
		`phi-router stopped this message. Your BAA account refused its key, so nothing was sent, and nothing reached your subscription. Run in a terminal: npx phi-router setup ${harness} --new-key`,
	noBaaKey: (harness) =>
		`phi-router stopped this message. It has no BAA key, so it has nowhere safe to send patient data. Nothing left your computer. Run in a terminal: npx phi-router setup ${harness}`,
	notStarted: (harness) =>
		`phi-router could not start, so this message was not sent. Nothing left your computer. Send it again. If it repeats, run: npx phi-router doctor ${harness}`,
};

export { stopLines };
