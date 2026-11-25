const piWire = {
	base: "/pi",
	models: { auto: "phi/auto", sealed: "phi/sealed" },
	portVariable: "PHI_ROUTER_PORT",
	provider: "phi",
	sessionHeader: "x-phi-session",
} as const;

export { piWire };
