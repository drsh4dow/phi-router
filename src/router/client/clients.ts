import { ClaudeSubagents } from "./harnesses/index.ts";
import { Digest } from "effect/crypto";
import { Layer } from "effect";
import { LeaseRegistry } from "./leases.ts";
import { LeaseRequests } from "./router-port/index.ts";
import { Processes } from "./processes.ts";
import { VerdictStore } from "./verdict-store.ts";

const clients = Layer.mergeAll(
	VerdictStore.layer,
	LeaseRegistry.layer,
	LeaseRequests.layer,
	Processes.layer,
	ClaudeSubagents.layer,
	Digest.layerWebCrypto,
);

export { clients };
