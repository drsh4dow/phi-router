/**
 * What the pi package and the router agree on: the path pi's requests start with, the header that names the session,
 * since pi sends none of its own, the variable that moves both off the product port, and the model ids of the provider
 * `phi` with the model name each stands for.
 */
const piWire = {
	base: "/pi",
	models: { auto: "phi/auto", sealed: "phi/sealed" },
	portVariable: "PHI_ROUTER_PORT",
	sessionHeader: "x-phi-session",
} as const;

export { piWire };
