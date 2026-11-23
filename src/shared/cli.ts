import { Schema } from "effect";

/** A `phi-router` command that pi ran did not start, exited non-zero, or printed what the contract does not allow. */
class CommandFailed extends Schema.TaggedError<CommandFailed, { readonly brand: unique symbol }>()("CommandFailed", {
	cause: Schema.Defect(),
	command: Schema.String,
}) {}

/** The fewest parts a count can hold. */
const none = 0;

/** The id a harness gives one session, the name its verdict store is kept under. */
const SessionId = Schema.NonEmptyString.pipe(Schema.brand("SessionId"));

/** The id the operating system gives one process, such as a harness instance's. Unbranded, since a lease holds it. */
const Pid = Schema.Int.check(Schema.isGreaterThan(none));

/** How many of a session's parts hold one verdict. */
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(none));

/** One account the router's configuration names, without its credential. */
const Account = Schema.Struct({ name: Schema.String, vendor: Schema.Literals(["anthropic", "openai"]) });

/**
 * What `status --session <id>` reports about one session: its pin, the accounts of each lane in order, how many of its
 * parts are sealed and cleared, and the account and model of its last request, `null` before its first, and whether that
 * model was the substitute.
 */
const Status = Schema.Struct({
	accounts: Schema.Struct({ clean: Schema.Array(Account), sealed: Schema.Array(Account) }),
	cleared: Count,
	last: Schema.NullOr(Schema.Struct({ account: Schema.String, model: Schema.String, substitute: Schema.Boolean })),
	pinned: Schema.Boolean,
	sealed: Count,
	session: SessionId,
});

/** The one line `status` prints on stdout. */
const StatusJson = Schema.fromJsonString(Status);

const RoutedModels = Schema.Struct({ auto: Schema.NonEmptyString, sealed: Schema.NonEmptyString });

/** The one line `models` prints on stdout: the models of each vendor `config.json` names, `{}` when there is none. */
const ModelsJson = Schema.fromJsonString(
	Schema.Struct({ anthropic: Schema.optionalKey(RoutedModels), openai: Schema.optionalKey(RoutedModels) }),
);

/** The address ADR 0002 names: the literal, never `localhost`, since another user can bind `[::1]`. */
const loopback = "127.0.0.1";

/** The product port, where `start` and the pi package find the router unless told another. */
const productPort = 47_411;

/** How the commands pi calls are spelled on the command line. */
const spelling = {
	models: { name: "models" },
	pin: { name: "pin", session: "session" },
	program: "phi-router",
	start: { folder: "folder", name: "start", pid: "pid", port: "port", session: "session" },
	status: { name: "status", session: "session" },
	unpin: { name: "unpin", session: "session" },
};

/** The command each harness adapter adds, `/phi`, and the two words it takes. */
const phiCommand = { name: "phi", pin: "pin", unpin: "unpin" } as const;

export { CommandFailed, ModelsJson, Pid, SessionId, Status, StatusJson, loopback, phiCommand, productPort, spelling };
