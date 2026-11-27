import { Array, Console, Effect, Struct, pipe } from "effect";
import {
	claudeSettings,
	customHeadersSetting,
	exemptionName,
	phiModels,
	restored,
	statusLineCommand,
	withoutCaller,
} from "./settings.ts";
import {
	modelPickerStatement,
	pickModels,
	removeStatusLine,
	rewriteEnv,
	statusLineStatement,
	userSettings,
} from "#router/client/harnesses/index.ts";

const names = pipe(
	claudeSettings,
	Array.map(({ name }) => name),
);

const off = Effect.fn("off claude")(function* off(configDir: string) {
	const settings = yield* userSettings(configDir);
	const exempt = restored(settings.env);
	const caller = withoutCaller(settings.env);
	const set = Struct.assign(exempt.set, caller.set);
	const { changed, path } = yield* rewriteEnv(configDir, set, [...names, ...exempt.unset, ...caller.unset]);
	const command = yield* statusLineCommand(configDir);
	const statusLineRemoved = yield* removeStatusLine(configDir, command);
	const pickerRemoved = yield* pickModels(configDir, phiModels, []);

	const removed = [
		...pipe(
			changed,
			Array.filter((name) => Array.contains(names, name)),
		),
		...Array.filter([customHeadersSetting], () => Array.contains(changed, customHeadersSetting)),
		...Array.filter([statusLineStatement], () => statusLineRemoved),
		...Array.filter([modelPickerStatement], () => pickerRemoved),
	];

	const exemptionLines = pipe(
		[`phi-router gave ${exemptionName} back as it was before on`],
		Array.filter(() => Array.contains(changed, exemptionName)),
	);

	yield* Console.log(
		Array.join(
			[`phi-router removed ${String(removed.length)} settings from ${path}`, ...removed, ...exemptionLines],
			"\n",
		),
	);
});

export { off };
