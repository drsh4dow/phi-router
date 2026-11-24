import { compaction } from "./compaction.request.ts";
import { customToolCall } from "./custom-tool-call.request.ts";
import { customToolCallReply } from "./custom-tool-call.reply.ts";
import { firstTurn } from "./first-turn.request.ts";
import { functionCall } from "./function-call.request.ts";
import { resumed } from "./resumed.request.ts";
import { spawnReply } from "./spawn.reply.ts";
import { subagent } from "./subagent.request.ts";
import { subagentParent } from "./subagent-parent.request.ts";

/** Request bodies Codex 0.166.0 sent through the #4 proxy, by what each shows. */
const requests = { compaction, customToolCall, firstTurn, functionCall, resumed, subagent, subagentParent } as const;

const replies = { customToolCallReply, spawnReply } as const;

export { replies, requests };
