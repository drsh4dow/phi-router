import { Schema } from "effect";

class CommandFailed extends Schema.TaggedError<CommandFailed, { readonly brand: unique symbol }>()("CommandFailed", {
	cause: Schema.Defect(),
	command: Schema.String,
}) {}

const none = 0;

const SessionId = Schema.NonEmptyString.pipe(Schema.brand("SessionId"));

const Pid = Schema.Int.check(Schema.isGreaterThan(none));

const PartCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(none));

const ConfiguredAccount = Schema.Struct({ name: Schema.String, vendor: Schema.Literals(["anthropic", "openai"]) });

const Status = Schema.Struct({
	accounts: Schema.Struct({ clean: Schema.Array(ConfiguredAccount), sealed: Schema.Array(ConfiguredAccount) }),
	cleared: PartCount,
	last: Schema.NullOr(Schema.Struct({ account: Schema.String, model: Schema.String, substitute: Schema.Boolean })),
	pinned: Schema.Boolean,
	sealed: PartCount,
	session: SessionId,
});

const StatusJson = Schema.fromJsonString(Status);

const RoutedModels = Schema.Struct({ auto: Schema.NonEmptyString, sealed: Schema.NonEmptyString });

const ModelsJson = Schema.fromJsonString(
	Schema.Struct({ anthropic: Schema.optionalKey(RoutedModels), openai: Schema.optionalKey(RoutedModels) }),
);

const loopback = "127.0.0.1";

const productPort = 47_411;

const spelling = {
	models: { name: "models" },
	pin: { name: "pin", session: "session" },
	program: "phi-router",
	start: { folder: "folder", name: "start", pid: "pid", port: "port", session: "session" },
	status: { name: "status", session: "session" },
	unpin: { name: "unpin", session: "session" },
};

const phiCommand = { name: "phi", pin: "pin", unpin: "unpin" } as const;

export { CommandFailed, ModelsJson, Pid, SessionId, Status, StatusJson, loopback, phiCommand, productPort, spelling };
