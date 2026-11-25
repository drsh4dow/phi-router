import { Array, Function, Option, Order, Schema, String as Str, pipe } from "effect";

const Release = Schema.String.check(Schema.isPattern(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u));

const parts = /^(?<core>[^-]*)(?:-(?<prerelease>.*))?$/u;

const numeric = /^\d+$/u;

const partsOf = (version: string): { readonly core: readonly number[]; readonly prerelease: readonly string[] } =>
	pipe(
		Option.fromNullishOr(parts.exec(version)),
		Option.flatMap(({ groups }) => Option.fromNullishOr(groups)),
		Option.match({
			onNone: () => ({ core: [], prerelease: [] }),
			onSome: ({ core = "", prerelease = "" }) => ({
				core: pipe(Str.split(core, "."), Array.map(Number)),
				prerelease: pipe(Str.split(prerelease, "."), Array.filter(Str.isNonEmpty)),
			}),
		}),
	);

const identifierOrder: Order.Order<string> = Order.combine(
	Order.mapInput(Order.Boolean, (identifier: string) => !numeric.test(identifier)),
	(self: string, that: string) => {
		if (numeric.test(self) && numeric.test(that)) {
			return Order.Number(Number(self), Number(that));
		}

		return Order.String(self, that);
	},
);

const coreOrder = Order.mapInput(Array.makeOrder(Order.Number), (version: string) => partsOf(version).core);

const releasedLast = Order.mapInput(Order.Boolean, (version: string) =>
	Array.isReadonlyArrayEmpty(partsOf(version).prerelease),
);

const prereleaseOrder = Order.mapInput(
	Array.makeOrder(identifierOrder),
	(version: string) => partsOf(version).prerelease,
);

const releaseOrder = Order.combine(coreOrder, Order.combine(releasedLast, prereleaseOrder));

const versionAndThan = 2;

const isOlder: {
	(than: string): (version: string) => boolean;
	(version: string, than: string): boolean;
} = Function.dual(versionAndThan, (version: string, than: string): boolean =>
	Order.isLessThan(releaseOrder)(version, than),
);

export { Release, isOlder };
