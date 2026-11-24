import type { ContentKey } from "#router/primitives/content-key.ts";

type Standing = "cleared" | "sealed" | "unknown";

type Lookup = (key: typeof ContentKey.Type) => Standing;

export type { Lookup, Standing };
