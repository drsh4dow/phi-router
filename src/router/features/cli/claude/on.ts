import { Array, Console, Effect, Record, Struct, pipe } from "effect";
import {
	claudeEnv,
	claudeSettings,
	exempted,
	exemptionName,
	exemptionReason,
	keptReason,
	keptStatusLine,
	recordReason,
	routerAddress,
	shellLists,
	statusLineCommand,
	statusLineReason,
} from "./settings.ts";
import { placeStatusLine, rewriteEnv, statusLineStatement, userSettings } from "#router/client/harnesses/index.ts";

const reasonOf = (name: string): string => {
	if (name === exemptionName) {
		return exemptionReason;
	}

	return recordReason;
};

const switchedOn = Effect.fnUntraced(function* switchedOn(configDir: string) {
	const settings = yield* userSettings(configDir);
	const shell = yield* shellLists;
	const exempt = exempted(routerAddress)({ settings: settings.env, shell });

	yield* rewriteEnv(configDir, Struct.assign(claudeEnv, exempt.set), exempt.unset);

	const command = yield* statusLineCommand(configDir);
	const statusLine = yield* placeStatusLine(configDir, command);

	return { command, exempt, path: settings.path, statusLine };
});

const on = Effect.fn("on claude")(function* on(configDir: string) {
	const { command, exempt, path, statusLine } = yield* switchedOn(configDir);

	const lines = pipe(
		claudeSettings,
		Array.flatMap(({ name, reason, value }) => [`${name}=${value}`, `  ${reason}`]),
	);

	const exemptionLines = pipe(
		Record.toEntries(exempt.set),
		Array.flatMap(([name, value]) => [`${name}=${value}`, `  ${reasonOf(name)}`]),
		Array.match({ onEmpty: () => [keptReason], onNonEmpty: (written) => written }),
	);

	const statusLineLines = {
		ours: [`${statusLineStatement}=${command}`, `  ${statusLineReason}`],
		theirs: keptStatusLine(command),
	}[statusLine];

	const count = claudeSettings.length + Record.size(exempt.set) + Number(statusLine === "ours");
	const wrote = `phi-router wrote ${String(count)} settings to ${path}`;

	const restart =
		"Restart each open Claude Code session: it now sends to the router, which only a new session starts.";

	yield* Console.log(
		Array.join(
			[wrote, ...lines, ...exemptionLines, ...statusLineLines, restart, "Next: phi-router doctor claude"],
			"\n",
		),
	);
});

export { on, switchedOn };
