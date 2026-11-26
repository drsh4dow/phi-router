import type { Handle } from "#router/primitives/handle.ts";
import { piWire } from "#shared/pi.ts";
import { stubTag } from "#router/primitives/handle.ts";

type Harness = "claude" | "codex" | "pi";

const claudePinnedAgent = "phi-router:phi-sealed";

const pinnedSubagentOf = {
	claude: `the ${claudePinnedAgent} subagent`,
	codex: "the phi-sealed subagent",
	pi: `a delegate on ${piWire.models.sealed}`,
} as const satisfies Record<Harness, string>;

const sealedStub =
	(harness: Harness) =>
	(handle: typeof Handle.Type): string =>
		`${stubTag(handle)} This part held patient identifiers, so phi-router withheld it. When the task needs it read, redacted or its identifiers used, hand that segment of the work to ${pinnedSubagentOf[harness]} with a scoped task that names ${handle}.`;

const bridgeOf = (pinnedSubagent: string): string =>
	`Refer to patients and members only by internal ids, such as a patient_id or a row id, never by name, SSN, date of birth, address, phone, email, member number or record number. A part shown as [sealed h<number>] held patient identifiers: phi-router keeps it, you cannot read it, and h<number> is its handle. Hand work to ${pinnedSubagent} only when the task needs a sealed part redacted, or needs its identifiers for one segment of the work. Scope each task tightly: name the handles it needs and say exactly what to return, because it cannot see this conversation and phi-router puts a part back only for it. Its calls are billed per token, so make as few as the task allows. When the user needs patient identifiers in the result, have it write them to a local file and report the file's path.`;

const bridgesFor = {
	claude: bridgeOf(pinnedSubagentOf.claude),
	codex: bridgeOf(pinnedSubagentOf.codex),
	pi: bridgeOf(pinnedSubagentOf.pi),
} as const satisfies Record<Harness, string>;

export { bridgesFor, claudePinnedAgent, sealedStub };

export type { Harness };
