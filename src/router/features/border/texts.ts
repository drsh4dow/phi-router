import { piWire } from "#shared/pi.ts";
import { stubs as policyStubs } from "#router/features/policy/index.ts";

type Harness = "claude" | "codex" | "pi";

const pinnedSubagent = { claude: "phi-router:phi-sealed", codex: "phi-sealed" } as const;

const whyTheReplyIsTrusted =
	"The next assistant reply was written there with this content in view, so what it says about this content is accurate.";

const handedTo = (subagent: string): string =>
	`Work that needs the identifiers themselves goes to the ${subagent} subagent.`;

const stubsFor = {
	claude: `${policyStubs.sealed} ${whyTheReplyIsTrusted} ${handedTo(pinnedSubagent.claude)}`,
	codex: `${policyStubs.sealed} ${whyTheReplyIsTrusted} ${handedTo(pinnedSubagent.codex)}`,
	pi: `${policyStubs.sealed} ${whyTheReplyIsTrusted} Work that needs the identifiers themselves needs the model switched to ${piWire.models.sealed}.`,
} as const satisfies Record<Harness, string>;

const bridgeOpening = `Refer to patients and members only by internal ids, such as a patient_id or a row id, never by name, SSN, date of birth, address, phone, email, member number or record number. A message shown as ${policyStubs.sealed} was handled on the HIPAA account. When the newest user message holds patient identifiers, open your reply by restating what was asked without them, because later requests will not include that message.`;

const bridgeNaming = (subagent: string): string =>
	`${bridgeOpening} When the work cannot be done without the identifiers themselves, hand it to the ${subagent} subagent and put the identifiers it needs in its prompt, because it cannot see this conversation.`;

const bridgesFor = {
	claude: bridgeNaming(pinnedSubagent.claude),
	codex: bridgeNaming(pinnedSubagent.codex),
	pi: `${bridgeOpening} When the work cannot be done without the identifiers themselves, ask for the model to be switched to ${piWire.models.sealed}.`,
} as const satisfies Record<Harness, string>;

export { bridgesFor, stubsFor };

export type { Harness };
