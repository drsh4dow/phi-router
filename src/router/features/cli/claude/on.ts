import { Array, Console, Effect, Record, Struct, pipe } from "effect";
import {
	claudeEnv,
	claudeSettings,
	exempted,
	exemptionName,
	exemptionReason,
	keptReason,
	phiModels,
	pickerReason,
	pickerRows,
	recordReason,
	removedStatusLine,
	routerAddress,
	shellLists,
	statusLineCommand,
} from "./settings.ts";
import {
	modelPickerStatement,
	pickModels,
	removeStatusLine,
	rewriteEnv,
	userSettings,
} from "#router/client/harnesses/index.ts";

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

	const rows = yield* pickerRows;

	yield* pickModels(configDir, phiModels, rows);

	const command = yield* statusLineCommand(configDir);
	const statusLineRemoved = yield* removeStatusLine(configDir, command);

	return {
		exempt,
		path: settings.path,
		rows,
		statusLineLines: Array.filter([removedStatusLine], () => statusLineRemoved),
	};
});

const on = Effect.fn("on claude")(function* on(configDir: string) {
	const { exempt, path, rows, statusLineLines } = yield* switchedOn(configDir);

	const lines = pipe(
		claudeSettings,
		Array.flatMap(({ name, reason, value }) => [`${name}=${value}`, `  ${reason}`]),
	);

	const exemptionLines = pipe(
		Record.toEntries(exempt.set),
		Array.flatMap(([name, value]) => [`${name}=${value}`, `  ${reasonOf(name)}`]),
		Array.match({ onEmpty: () => [keptReason], onNonEmpty: (written) => written }),
	);

	const pickerLines = Array.match(rows, {
		onEmpty: () => [],
		onNonEmpty: (written) => [
			`${modelPickerStatement}=${pipe(
				written,
				Array.map(({ behavesAs, model }) => `${model} as ${behavesAs}`),
				Array.join(", "),
			)}`,
			`  ${pickerReason}`,
		],
	});

	const count = claudeSettings.length + Record.size(exempt.set) + Number(Array.isReadonlyArrayNonEmpty(rows));

	const wrote = `phi-router wrote ${String(count)} settings to ${path}`;

	const restart =
		"Restart each open Claude Code session: it now sends to the router, which only a new session starts.";

	yield* Console.log(
		Array.join(
			[
				wrote,
				...lines,
				...exemptionLines,
				...statusLineLines,
				...pickerLines,
				restart,
				"Next: phi-router doctor claude",
			],
			"\n",
		),
	);
});

export { on, switchedOn };
