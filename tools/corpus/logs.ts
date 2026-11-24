import { Array, Order, Record, String as Str, pipe } from "effect";
import type { Labelled, RenderInput } from "./record.ts";
import { labelledValues, recordObject, systemTime } from "./record.ts";
import type { Random } from "./random.ts";
import { compactJson } from "./encodings.ts";
import { phrases } from "./labels.ts";

const services: Array.NonEmptyReadonlyArray<string> = [
	"claims-worker",
	"etl-loader",
	"eligibility-sync",
	"billing-export",
	"intake-api",
];

const keyValue = ({ snakeCaseKey, value }: Labelled): string => {
	if (/[\s"=]/u.test(value)) {
		return `${snakeCaseKey}="${value}"`;
	}

	return `${snakeCaseKey}=${value}`;
};

const secondStampLength = 20;
const firstMilli = 0;
const lastMilli = 999;
const milliDigits = 3;

const burst = (rng: Random, count: number): readonly string[] => {
	const second = Str.takeLeft(systemTime(rng), secondStampLength);

	return pipe(
		Array.makeBy(count, () => rng.between(firstMilli, lastMilli)),
		Array.sortBy(Order.Number),
		Array.map((milli) => `${second}${Str.padStart(milliDigits, "0")(String(milli))}Z`),
	);
};

const linesPerBurst = 4;
const partitionCount = 12;
const batchIdDigits = 5;
const fewestCommitted = 40;
const mostCommitted = 400;
const levelWidth = 5;

interface LogEvent {
	readonly level: string;
	readonly msg: string;
	readonly ts: string;
}

interface JsonLog {
	readonly service: string;
	readonly rejected: string;
	readonly values: readonly Labelled[];
}

const jsonLineOf =
	({ service, rejected, values }: JsonLog) =>
	({ ts, level, msg }: LogEvent): string => {
		if (level === "ERROR") {
			return compactJson(
				Record.fromEntries([
					["ts", ts],
					["level", "error"],
					["service", service],
					["msg", rejected],
					["record", recordObject(values)],
				]),
			);
		}

		return compactJson(
			Record.fromEntries([
				["ts", ts],
				["level", Str.toLowerCase(level)],
				["service", service],
				["msg", msg],
			]),
		);
	};

const logLine = ({ record, rng, minified }: RenderInput): string => {
	const service = rng.pick(services);
	const values = labelledValues(record);
	const batch = rng.digits(batchIdDigits);
	const rejected = phrases.rejected[record.lang];
	const [start, retry, failure, commit] = burst(rng, linesPerBurst);

	const failed = pipe(
		values,
		Array.map((value) => keyValue(value)),
		Array.join(" "),
	);

	const events: readonly LogEvent[] = [
		{
			level: "INFO",
			msg: `consumer started topic=claims.inbound partition=${String(rng.int(partitionCount))}`,
			ts: start ?? "",
		},
		{ level: "WARN", msg: `retrying batch=${batch} attempt=2 reason=upstream_timeout`, ts: retry ?? "" },
		{ level: "ERROR", msg: `${rejected}: ${failed}`, ts: failure ?? "" },
		{
			level: "INFO",
			msg: `batch=${batch} committed ok=${String(rng.between(fewestCommitted, mostCommitted))} failed=1`,
			ts: commit ?? "",
		},
	];

	if (minified) {
		return pipe(events, Array.map(jsonLineOf({ rejected, service, values })), Array.join("\n"));
	}

	return pipe(
		events,
		Array.map(({ ts, level, msg }) => `${ts} ${Str.padEnd(levelWidth)(level)} ${service} ${msg}`),
		Array.join("\n"),
	);
};

const javaTrace = (message: string, values: readonly Labelled[]): string =>
	Array.join(
		[
			`com.northfield.etl.RecordRejectedException: ${message}: {${pipe(
				values,
				Array.map(({ snakeCaseKey, value }) => `${snakeCaseKey}=${value}`),
				Array.join(", "),
			)}}`,
			"\tat com.northfield.etl.ClaimMapper.map(ClaimMapper.java:142)",
			"\tat com.northfield.etl.BatchRunner.lambda$run$0(BatchRunner.java:88)",
			"\tat java.base/java.util.stream.ReferencePipeline$3$1.accept(ReferencePipeline.java:197)",
			"\tat com.northfield.etl.BatchRunner.run(BatchRunner.java:91)",
			"\tat java.base/java.lang.Thread.run(Thread.java:1583)",
		],
		"\n",
	);

const pythonTrace = (message: string, values: readonly Labelled[]): string =>
	Array.join(
		[
			"Traceback (most recent call last):",
			'  File "/app/etl/pipeline.py", line 211, in run',
			"    rows = [mapper.map_row(row) for row in batch]",
			'  File "/app/etl/mapper.py", line 88, in map_row',
			"    raise RecordRejected(row)",
			`etl.errors.RecordRejected: ${message}: {${pipe(
				values,
				Array.map(({ snakeCaseKey, value }) => `'${snakeCaseKey}': '${value}'`),
				Array.join(", "),
			)}}`,
		],
		"\n",
	);

const nodeTrace = (message: string, values: readonly Labelled[]): string =>
	Array.join(
		[
			`Error: ${message}: ${compactJson(recordObject(values))}`,
			"    at mapRow (/srv/app/dist/mapper.js:142:11)",
			"    at Array.map (<anonymous>)",
			"    at processBatch (/srv/app/dist/worker.js:57:24)",
			"    at async Consumer.run (/srv/app/dist/consumer.js:31:7)",
		],
		"\n",
	);

interface Trace {
	readonly type: string;
	readonly write: (message: string, values: readonly Labelled[]) => string;
}

const traces: Array.NonEmptyReadonlyArray<Trace> = [
	{ type: "RecordRejectedException", write: javaTrace },
	{ type: "RecordRejected", write: pythonTrace },
	{ type: "Error", write: nodeTrace },
];

const stackTrace = ({ record, rng, minified }: RenderInput): string => {
	const { type, write } = rng.pick(traces);
	const message = phrases.rejected[record.lang];
	const trace = write(message, labelledValues(record));

	if (minified) {
		return compactJson({
			error: Record.fromEntries([
				["type", type],
				["message", message],
				["stack", trace],
			]),
		});
	}

	return trace;
};

export { logLine, stackTrace };
