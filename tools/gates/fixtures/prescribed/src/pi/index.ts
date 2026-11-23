import { Effect } from "effect";

/** Starts the extension's Effects when pi loads it. */
const activate = (): void => {
	Effect.runFork(Effect.void);
};

export { activate };
