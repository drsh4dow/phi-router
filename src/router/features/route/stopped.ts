import type { Harness } from "#router/features/border/index.ts";
import { phiCommand } from "#shared/cli.ts";

type Stop = "noBaaKey" | "baaKeyRefused" | "notStarted";

const setupRun = (harness: Harness): string => {
	if (harness === "pi") {
		return `Type /${phiCommand.name} ${phiCommand.setup}.`;
	}

	return `Run in a terminal: npx phi-router setup ${harness}`;
};

const stopLines: Readonly<Record<Stop, (harness: Harness) => string>> = {
	baaKeyRefused: (harness) =>
		`phi-router stopped this message. Your BAA account refused its key, so nothing was sent, and nothing reached your subscription. Run in a terminal: npx phi-router setup ${harness} --new-key`,
	noBaaKey: (harness) =>
		`phi-router stopped this message. It is missing your BAA key or the OpenAI key for its PHI check. Nothing left your computer. ${setupRun(harness)}`,
	notStarted: (harness) =>
		`phi-router could not start, so this message was not sent. Nothing left your computer. Send it again. If it repeats, run: npx phi-router doctor ${harness}`,
};

export { stopLines };
