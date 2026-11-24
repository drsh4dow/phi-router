import { Array, Number as Num, Option, String as Str, pipe } from "effect";
import { dateIn2025, month, two, uuidWith } from "./record.ts";
import type { Carrier } from "./manifest.ts";
import type { Random } from "./random.ts";
import { diffHeader } from "./files.ts";

type Words = Array.NonEmptyReadonlyArray<string>;

type LineSource = (rng: Random) => string;

const services: Words = [
	"api-gateway",
	"claims-worker",
	"auth",
	"scheduler",
	"notifier",
	"search-indexer",
	"remit-poller",
];

const routes: Words = [
	"/api/v2/claims",
	"/api/v2/claims/status",
	"/api/v2/eligibility",
	"/healthz",
	"/metrics",
	"/api/v2/remits",
];

const tables: Words = ["products", "feature_flags", "audit_events", "shipments", "inventory", "job_runs"];
const verbs: Words = ["load", "parse", "map", "sync", "fetch", "build", "merge", "resolve", "flush", "index", "retry"];
const nouns: Words = ["Batch", "Remit", "Payer", "Config", "Session", "Cursor", "Ledger", "Queue", "Token", "Report"];
const dirs: Words = ["billing", "claims", "eligibility", "shared", "api", "workers", "db", "util", "auth", "reports"];
const fields: Words = ["status", "createdAt", "batchId", "retries", "total", "cursor", "version", "region"];

const millisPerSecond = 1000;

const secondsPerMinute = 60;

const secondsPerHour = 3600;

const minutesPerHour = 60;

const hoursPerDay = 24;

const millisecondDigits = 3;

const logClock = {
	startMillisAfterMidnight: { max: 20_000_000, min: 0 },
	stepMillis: { max: 900, min: 1 },
} as const;

const traceIdHexDigits = 16;

const cacheKeyHexDigits = 8;

const batchIdDigits = 5;

const logRanges = {
	attempt: { max: 5, min: 1 },
	gcPauseMs: { max: 80, min: 1 },
	heapMb: { max: 900, min: 200 },
	limit: { max: 500, min: 10 },
	port: { max: 9100, min: 8000 },
	requestMs: { max: 2400, min: 1 },
	ttlSeconds: { max: 900, min: 30 },
} as const;

const logCountsBelow = {
	kafkaLag: 5000,
	partition: 12,
	poolActive: 40,
	poolIdle: 20,
	poolWaiting: 5,
	rows: 2000,
} as const;

const rowNumbers = {
	centDigits: 2,
	flagRollout: 101,
	productIdDigits: 6,
	productPrice: { max: 900, min: 1 },
	salePrice: { max: 300, min: 1 },
	saleUnits: 400,
	shipmentIdDigits: 7,
	skuDigits: 5,
	stock: 4000,
	trackingChars: 16,
} as const;

const fallbackLine = 100;

const archiveBatchDigits = 4;

const hunk = { changed: { max: 5, min: 1 }, start: { max: 400, min: 1 } } as const;

const burial = { minShare: 0.35, percent: 100, spreadPercent: 30 } as const;

const newline = "\n";

const auditEventId = uuidWith(() => "a");

const clock = (rng: Random): (() => string) => {
	const day = dateIn2025(rng);
	let millis = rng.between(logClock.startMillisAfterMidnight.min, logClock.startMillisAfterMidnight.max);

	return () => {
		millis += rng.between(logClock.stepMillis.min, logClock.stepMillis.max);

		const seconds = Math.floor(millis / millisPerSecond);
		const hour = two(Math.floor(seconds / secondsPerHour) % hoursPerDay);
		const minute = two(Math.floor(seconds / secondsPerMinute) % minutesPerHour);
		const fraction = Str.padStart(millisecondDigits, "0")(String(millis % millisPerSecond));

		return `${day}T${hour}:${minute}:${two(seconds % secondsPerMinute)}.${fraction}Z`;
	};
};

const logMessages = (rng: Random, service: string): Array.NonEmptyReadonlyArray<() => string> => {
	const ms = String(rng.between(logRanges.requestMs.min, logRanges.requestMs.max));

	return [
		() =>
			`INFO  ${service} ${rng.pick(["GET", "POST", "PUT"])} ${rng.pick(routes)} ${rng.pick(["200", "200", "201", "204", "404", "503"])} ${ms}ms req=${rng.hex(traceIdHexDigits)}`,
		() =>
			`DEBUG ${service} cache ${rng.pick(["hit", "miss"])} key=${Str.toLowerCase(rng.pick(nouns))}:${rng.hex(cacheKeyHexDigits)} ttl=${String(rng.between(logRanges.ttlSeconds.min, logRanges.ttlSeconds.max))}s`,
		() =>
			`INFO  ${service} db pool active=${String(rng.int(logCountsBelow.poolActive))} idle=${String(rng.int(logCountsBelow.poolIdle))} waiting=${String(rng.int(logCountsBelow.poolWaiting))}`,
		() =>
			`WARN  ${service} slow query ${ms}ms: SELECT * FROM ${rng.pick(tables)} WHERE status = $1 LIMIT ${String(rng.between(logRanges.limit.min, logRanges.limit.max))}`,
		() =>
			`INFO  ${service} kafka lag topic=${rng.pick(["remits.raw", "jobs.events", "audit.log"])} partition=${String(rng.int(logCountsBelow.partition))} lag=${String(rng.int(logCountsBelow.kafkaLag))}`,
		() =>
			`DEBUG ${service} gc pause=${String(rng.between(logRanges.gcPauseMs.min, logRanges.gcPauseMs.max))}ms heap_used=${String(rng.between(logRanges.heapMb.min, logRanges.heapMb.max))}MB`,
		() =>
			`INFO  scheduler job=${rng.pick(verbs)}-${Str.toLowerCase(rng.pick(nouns))} status=finished duration=${ms}ms`,
		() =>
			`DEBUG ${service} flag ${rng.pick(verbs)}_${Str.toLowerCase(rng.pick(nouns))}_v2=${rng.pick(["true", "false"])}`,
		() =>
			`WARN  ${service} retrying POST https://${rng.pick(services)}.internal/v1/${rng.pick(dirs)} attempt=${String(rng.between(logRanges.attempt.min, logRanges.attempt.max))}`,
		() =>
			`INFO  ${service} span=${rng.hex(traceIdHexDigits)} parent=${rng.hex(traceIdHexDigits)} op=${rng.pick(verbs)}${rng.pick(nouns)} dur=${ms}ms`,
		() =>
			`INFO  ${service} tls handshake ok peer=${rng.pick(services)}.svc.cluster.local:${String(rng.between(logRanges.port.min, logRanges.port.max))}`,
		() =>
			`INFO  ${service} batch=${rng.digits(batchIdDigits)} rows=${String(rng.int(logCountsBelow.rows))} committed in ${ms}ms`,
	];
};

const logLine = (rng: Random, now: () => string): string => {
	const service = rng.pick(services);
	const messages = logMessages(rng, service);
	const time = now();

	return `${time} ${rng.pick(messages)()}`;
};

const sqlLine = (rng: Random): string => {
	const rows: Array.NonEmptyReadonlyArray<() => string> = [
		() =>
			`INSERT INTO public.products VALUES (${rng.digits(rowNumbers.productIdDigits)}, 'SKU-${rng.digits(rowNumbers.skuDigits)}', '${rng.pick(nouns)} ${rng.pick(["kit", "cable", "license", "adapter"])}', ${String(rng.between(rowNumbers.productPrice.min, rowNumbers.productPrice.max))}.${rng.digits(rowNumbers.centDigits)});`,
		() =>
			`INSERT INTO public.feature_flags VALUES ('${rng.pick(verbs)}_${Str.toLowerCase(rng.pick(nouns))}', ${rng.pick(["true", "false"])}, ${String(rng.int(rowNumbers.flagRollout))});`,
		() =>
			`INSERT INTO public.audit_events VALUES ('${auditEventId(rng)}', '${rng.pick(verbs)}', '${rng.pick(services)}');`,
		() =>
			`INSERT INTO public.shipments VALUES (${rng.digits(rowNumbers.shipmentIdDigits)}, '${rng.pick(["UPS", "FEDEX", "DHL"])}', '1Z${rng.chars("ABCDEFGHJKLMNPRSTUVWXYZ0123456789", rowNumbers.trackingChars)}', '${rng.pick(["in_transit", "delivered", "label_created"])}');`,
		() =>
			`INSERT INTO public.inventory VALUES ('SKU-${rng.digits(rowNumbers.skuDigits)}', '${rng.pick(["pdx-1", "iad-2", "fra-1"])}', ${String(rng.int(rowNumbers.stock))});`,
	];

	return rng.pick(rows)();
};

const csvLine = (rng: Random): string =>
	`${dateIn2025(rng)},${rng.pick(["us-west", "us-east", "eu-central"])},SKU-${rng.digits(rowNumbers.skuDigits)},${String(rng.int(rowNumbers.saleUnits))},${String(rng.between(rowNumbers.salePrice.min, rowNumbers.salePrice.max))}.${rng.digits(rowNumbers.centDigits)},${rng.pick(["web", "partner", "retail"])}`;

const functionLines = (rng: Random): string[] => {
	const [verb, noun, field, other] = [rng.pick(verbs), rng.pick(nouns), rng.pick(fields), rng.pick(fields)];
	const local = Str.toLowerCase(noun);

	return [
		`export async function ${verb}${noun}(input: ${rng.pick(nouns)}Input): Promise<${noun}> {`,
		`\tconst ${local} = await client.${rng.pick(verbs)}${noun}(input.${field});`,
		`\tif (${local}.${other} === undefined) {`,
		`\t\tthrow new ${noun}Error("missing ${other}", { ${field}: input.${field} });`,
		"\t}",
		`\tlogger.debug("${verb} ${local}", { ${field}: input.${field}, ms: Date.now() - started });`,
		`\treturn { ...${local}, ${other}: ${local}.${other} ?? ${String(rng.int(fallbackLine))} };`,
		"}",
	];
};

const diffBlock = (rng: Random): string => {
	const path = `src/${rng.pick(dirs)}/${Str.toLowerCase(rng.pick(nouns))}.ts`;
	const start = String(rng.between(hunk.start.min, hunk.start.max));
	const body = functionLines(rng);
	const changed = rng.between(hunk.changed.min, hunk.changed.max);
	const field = rng.pick(fields);
	const added = [`\tif (input.${field} === null) return undefined;`, functionLines(rng)[changed] ?? ""];
	const after = Array.drop(body, Num.increment(changed));

	return Array.join(
		[
			...diffHeader({ path, rng }),
			`@@ -${start},${String(body.length)} +${start},${String(Num.increment(body.length))} @@`,
			...pipe(
				Array.take(body, changed),
				Array.map((line) => ` ${line}`),
			),
			`-${body[changed] ?? ""}`,
			...pipe(
				added,
				Array.map((line) => `+${line}`),
			),
			...pipe(
				after,
				Array.map((line) => ` ${line}`),
			),
		],
		newline,
	);
};

const pathLine = (rng: Random): string => {
	const paths: Array.NonEmptyReadonlyArray<() => string> = [
		() => `./src/${rng.pick(dirs)}/${rng.pick(dirs)}/${rng.pick(verbs)}-${Str.toLowerCase(rng.pick(nouns))}.ts`,
		() => `./node_modules/@${rng.pick(dirs)}/${Str.toLowerCase(rng.pick(nouns))}/dist/${rng.pick(verbs)}.js`,
		() => `./test/${rng.pick(dirs)}/${rng.pick(verbs)}-${Str.toLowerCase(rng.pick(nouns))}.test.ts`,
		() => `./exports/archive/2025-${month(rng)}/batch_${rng.digits(archiveBatchDigits)}.csv`,
	];

	return rng.pick(paths)();
};

const lineSources: Partial<Record<typeof Carrier.Type, LineSource>> = {
	csv: csvLine,
	"file-name": pathLine,
	"git-diff": diffBlock,
	"sql-dump": sqlLine,
};

const lineSource = (carrier: typeof Carrier.Type, rng: Random): LineSource =>
	Option.getOrElse(Option.fromUndefinedOr(lineSources[carrier]), () => {
		const now = clock(rng);

		return (draw: Random) => logLine(draw, now);
	});

const fill = (drawLine: LineSource, rng: Random, size: number): string => {
	const lines: string[] = [];
	let length = 0;

	while (length < size) {
		const line = drawLine(rng);

		lines.push(line);
		length += line.length + newline.length;
	}

	return Array.join(lines, newline);
};

interface BuryRequest {
	readonly rng: Random;
	readonly carrier: typeof Carrier.Type;
	readonly size: number;
}

const bury =
	({ rng, carrier, size }: BuryRequest) =>
	(payload: string): string => {
		const drawLine = lineSource(carrier, rng);
		const share = burial.minShare + rng.int(burial.spreadPercent) / burial.percent;
		const before = Math.floor(size * share);

		return `${fill(drawLine, rng, before)}\n${payload}\n${fill(drawLine, rng, size - before)}`;
	};

export { bury };
