import { Schema } from "effect";

class CommandFailed extends Schema.TaggedError<CommandFailed, { readonly brand: unique symbol }>()("CommandFailed", {
	cause: Schema.Defect(),
	command: Schema.String,
}) {}

const none = 0;

const SessionId = Schema.NonEmptyString.pipe(Schema.brand("SessionId"));

const Pid = Schema.Int.check(Schema.isGreaterThan(none));

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(none));

const AccountVendor = Schema.Literals(["anthropic", "openai"]);

const ConfiguredAccount = Schema.Struct({ name: Schema.String, vendor: AccountVendor });

const OpenAccount = Schema.Struct({
	name: Schema.String,
	rateLimitedUntil: Schema.optionalKey(Schema.String),
	vendor: AccountVendor,
});

const PinnedCounts = Schema.Struct({ gaveUp: Count, rewrites: Count, runs: Count });

const Status = Schema.Struct({
	accounts: Schema.Struct({ clean: Schema.Array(OpenAccount), sealed: Schema.Array(ConfiguredAccount) }),
	cleared: Count,
	last: Schema.NullOr(Schema.Struct({ account: Schema.String, model: Schema.String, substitute: Schema.Boolean })),
	overflowed: Schema.optionalKey(Count),
	pinned: Schema.optionalKey(PinnedCounts),
	sealed: Count,
	session: SessionId,
});

const StatusJson = Schema.fromJsonString(Status);

const AnswerCheck = Schema.Struct({
	answer: Schema.String,
	session: Schema.NonEmptyString,
	subagent: Schema.NonEmptyString,
});

const AnswerCheckJson = Schema.fromJsonString(AnswerCheck);

const AnswerChecked = Schema.Union([
	Schema.Struct({ outcome: Schema.Literal("cleared") }),
	Schema.Struct({ attempt: Count, limit: Count, message: Schema.String, outcome: Schema.Literal("rewrite") }),
	Schema.Struct({ handle: Schema.String, outcome: Schema.Literal("gave-up"), reply: Schema.String }),
]);

const AnswerCheckedJson = Schema.fromJsonString(AnswerChecked);

const RoutedModels = Schema.Struct({ auto: Schema.NonEmptyString, sealed: Schema.NonEmptyString });

const ModelsJson = Schema.fromJsonString(
	Schema.Struct({ anthropic: Schema.optionalKey(RoutedModels), openai: Schema.optionalKey(RoutedModels) }),
);

const SetupVendor = Schema.Literals(["anthropic", "openai"]);

const QuestionId = Schema.Literals(["enterprise", "everyday", "baa", "judge", "another"]);

const ChoiceId = Schema.Literals([
	"yes",
	"no",
	"subscription",
	"nothing",
	"key",
	"signIn",
	"env",
	"pi",
	"saved",
	"none",
]);

const Answer = Schema.optionalKey(ChoiceId);

const SetupAnswers = Schema.Struct({
	another: Answer,
	baa: Answer,
	enterprise: Answer,
	everyday: Answer,
	judge: Answer,
});

const SetupAnswersJson = Schema.fromJsonString(SetupAnswers);

const SetupChoice = Schema.Struct({ id: ChoiceId, label: Schema.String });

const SetupQuestion = Schema.Struct({
	choices: Schema.Array(SetupChoice),
	id: QuestionId,
	text: Schema.String,
});

const Found = Schema.Array(Schema.String);

const SetupKey = Schema.Struct({ prompt: Schema.String, vendor: SetupVendor });

const SetupStep = Schema.Union([
	Schema.Struct({ found: Found, kind: Schema.Literal("ask"), question: SetupQuestion }),
	Schema.Struct({ found: Found, kind: Schema.Literal("stop"), line: Schema.String }),
	Schema.Struct({
		found: Found,
		keys: Schema.Array(SetupKey),
		kind: Schema.Literal("ready"),
	}),
]);

const SetupStepJson = Schema.fromJsonString(SetupStep);

const loopback = "127.0.0.1";

const productPort = 47_411;

const spelling = {
	models: { name: "models" },
	program: "phi-router",
	setup: {
		answers: "answers",
		apply: "apply",
		json: "json",
		keys: { anthropic: "PHI_ROUTER_ANTHROPIC_KEY", openai: "PHI_ROUTER_OPENAI_KEY" },
		name: "setup",
	},
	start: { folder: "folder", name: "start", pid: "pid", port: "port", session: "session" },
	status: { name: "status", session: "session" },
};

const setupEnded = "Setup ended before it finished. Nothing was saved or changed.";

const phiCommand = { name: "phi", setup: "setup" } as const;

export {
	AnswerCheck,
	AnswerCheckJson,
	AnswerChecked,
	AnswerCheckedJson,
	CommandFailed,
	ModelsJson,
	Pid,
	SessionId,
	SetupAnswersJson,
	SetupQuestion,
	SetupStepJson,
	SetupVendor,
	Status,
	StatusJson,
	loopback,
	phiCommand,
	productPort,
	setupEnded,
	spelling,
};
