import { covered, noLeaks, playedWith } from "./default-corpus-replay.ts";
import { it } from "@effect/vitest";

it.layer(playedWith("claude"), { timeout: "10 minutes" })("the default corpus with the Claude judge", (test) => {
	test.effect("the recorded answers cover every judge call of the default corpus", () => covered);

	test.effect("no complete identifier in the default corpus reaches an open account in one message", () => noLeaks);
});
