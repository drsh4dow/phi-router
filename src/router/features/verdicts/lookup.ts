import type { ContentKey } from "#router/primitives/content-key.ts";

/** What is known of one part: its verdict, or `unknown` when it was never judged. */
type Standing = "cleared" | "sealed" | "unknown";

/** The verdicts of one session as the lane choice and the border read them. */
type Lookup = (key: typeof ContentKey.Type) => Standing;

export type { Lookup, Standing };
