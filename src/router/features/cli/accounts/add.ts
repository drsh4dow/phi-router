import { Console, DateTime, Effect, Option, Predicate } from "effect";
import { fromCommand, fromFolder, refused } from "./found.ts";
import { addAccounts } from "#router/client/config-writer.ts";
import { fromLogin } from "./login.ts";
import { laneOf } from "#router/features/lanes/index.ts";
import { realFolder } from "#router/client/processes.ts";

interface AddRequest {
	readonly loginFolder: string | undefined;
	readonly keyCommand: string | undefined;
	readonly sealed: boolean;
}

const foundBy = Effect.fnUntraced(function* foundBy(request: AddRequest) {
	const { keyCommand, loginFolder } = request;

	if (Predicate.isNotUndefined(loginFolder) && Predicate.isNotUndefined(keyCommand)) {
		return yield* refused("Name a login folder or --command, not both.");
	}

	if (Predicate.isNotUndefined(loginFolder)) {
		return yield* Effect.flatMap(realFolder(loginFolder), fromFolder);
	}

	if (Predicate.isNotUndefined(keyCommand)) {
		return yield* fromCommand(keyCommand);
	}

	if (request.sealed) {
		return yield* refused('Name a login folder, or --command "<prints the token>".');
	}

	return yield* fromLogin();
});

const accountsAdd = Effect.fn("accountsAdd")(function* accountsAdd(request: AddRequest) {
	const lane = laneOf(request.sealed);
	const found = yield* foundBy(request);

	const [placed] = yield* addAccounts({ accounts: [{ account: found.account, lane }] }).pipe(
		Effect.catchTags({
			PlatformError: (error) => Effect.fail(refused(`config.json could not be read or written. ${error.message}`)),
			SchemaError: (error) =>
				Effect.fail(refused(`The router could not serve config.json with this account. ${error.message}.`)),
		}),
	);

	if (!placed.isNew) {
		return yield* Console.log(`${placed.name} is already on the ${placed.lane} lane. Nothing changed.`);
	}

	const where = Option.match(placed.vendorAccountBefore, {
		onNone: () => `the first ${found.vendorName} account there`,
		onSome: (before) => `after ${before}`,
	});

	return yield* Console.log(
		`Added ${placed.name} to the ${lane} lane, ${where}.\n  ${found.summary}\nA running router serves it from its next request.`,
	);
}, DateTime.withCurrentZoneLocal);

export { accountsAdd };
