import { Effect } from "effect";

const activate = (): void => {
	Effect.runFork(Effect.void);
};

export { activate };
