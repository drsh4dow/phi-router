import { Context } from "effect";

class Platform extends Context.Service<
	Platform,
	{ readonly name: "bun" | "node"; readonly entry: string; readonly os: string }
>()("phi-router/router/features/cli/platform") {}

export { Platform };
