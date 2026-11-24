import { Array, Record, String as Str, pipe } from "effect";
import { systemTime, uuid } from "./record.ts";
import type { Random } from "./random.ts";
import type { Sample } from "./conversation.ts";
import type { TextCarrier } from "./manifest.ts";
import { carriers } from "./carriers.ts";
import { diagnoses } from "./health.ts";
import { prettyJson } from "./encodings.ts";

const firstPatientId = 1000;
const lastPatientId = 99_999;

const patientId = (rng: Random): string => String(rng.between(firstPatientId, lastPatientId));

const clientCodeDigits = 4;

const clientCode = (rng: Random): string => `NFH-${rng.digits(clientCodeDigits)}`;

const fewestQueuedRows = 4;
const mostQueuedRows = 7;
const patientIdWidth = 10;
const statusWidth = 8;
const secondStampLength = 19;
const fewestAttempts = 1;
const mostAttempts = 6;

const syncQueue = (rng: Random): Sample => {
	const rows = Array.makeBy(rng.between(fewestQueuedRows, mostQueuedRows), () =>
		Array.join(
			[
				Str.padStart(patientIdWidth)(patientId(rng)),
				clientCode(rng),
				Str.padEnd(statusWidth)(rng.pick(["pending", "failed", "retry"])),
				Str.takeLeft(systemTime(rng), secondStampLength),
				String(rng.between(fewestAttempts, mostAttempts)),
			],
			" | ",
		),
	);

	return {
		payload: Array.join(
			[
				"patient_id | client_code | sync_status | updated_at          | attempts",
				"-----------+-------------+-------------+---------------------+---------",
				...rows,
				`(${String(rows.length)} rows)`,
			],
			"\n",
		),
		scene: {
			asks: [
				"The nightly sync skips some patients. Why do these rows never leave the queue?",
				"Which of these sync rows should the retry job pick up?",
			],
			commands: [
				`psql -c "select patient_id, client_code, sync_status, updated_at, attempts from sync_queue where sync_status <> 'done'"`,
			],
			paths: ["tmp/sync_queue.txt"],
		},
	};
};

const episodeIdDigits = 6;
const firstRowVersion = 1;
const lastRowVersion = 40;

const apiPayload = (rng: Random): Sample => {
	const body = Record.fromEntries([
		["requestId", uuid(rng)],
		["patientId", uuid(rng)],
		["clientCode", clientCode(rng)],
		["episodeId", Number(rng.digits(episodeIdDigits))],
		["rowVersion", rng.between(firstRowVersion, lastRowVersion)],
		["action", rng.pick(["enroll", "transfer", "disenroll"])],
		["effective", "2025-04-01"],
	]);

	return {
		payload: prettyJson(body),
		scene: {
			asks: ["The enrollment API returns 409 for this request body. What conflicts?", "Is this request body valid?"],
			commands: ["cat tmp/last_request.json"],
			paths: ["tmp/last_request.json"],
		},
	};
};

const fewestLogLines = 3;
const mostLogLines = 6;
const firstSyncStep = 1;
const syncSteps = 5;
const traceIdLength = 16;

const workerLog = (rng: Random): Sample => ({
	payload: Array.join(
		Array.makeBy(
			rng.between(fewestLogLines, mostLogLines),
			() =>
				`${systemTime(rng)} sync patient_id=${patientId(rng)} client=${clientCode(rng)} step=${String(rng.between(firstSyncStep, syncSteps))}/${String(syncSteps)} status=${rng.pick(["ok", "failed", "retrying"])} trace=${rng.hex(traceIdLength)}`,
		),
		"\n",
	),
	scene: {
		asks: ["Why does the sync worker keep failing at step 3?", "Which patient ids hit the timeout?"],
		commands: ["kubectl logs deploy/sync-worker --since=30m | grep patient_id"],
		paths: ["logs/sync-worker.log"],
	},
});

const fewestBackfilled = 3;
const mostBackfilled = 8;

const migration = (rng: Random): Sample => {
	const ids = Array.makeBy(rng.between(fewestBackfilled, mostBackfilled), () => patientId(rng));

	return {
		payload: Array.join(
			[
				"BEGIN;",
				`UPDATE enrollments SET status = 'inactive', updated_by = 'backfill-0118' WHERE patient_id IN (${Array.join(ids, ", ")});`,
				`DELETE FROM sync_queue WHERE client_code = '${clientCode(rng)}' AND attempts > 5;`,
				"COMMIT;",
			],
			"\n",
		),
		scene: {
			asks: ["Review this backfill before I run it on prod.", "Will this migration lock the enrollments table?"],
			commands: ["cat db/migrations/0118_backfill_inactive.sql"],
			paths: ["db/migrations/0118_backfill_inactive.sql"],
		},
	};
};

const internalIds: Array.NonEmptyReadonlyArray<(rng: Random) => Sample> = [syncQueue, apiPayload, workerLog, migration];

const internalOnly: Array.NonEmptyReadonlyArray<TextCarrier> = [
	"sql-dump",
	"csv",
	"fhir-json",
	"hl7v2",
	"log-line",
	"stack-trace",
	"clinical-note",
	"ticket",
	"git-diff",
	"file-name",
];

const minifiedShare = 0.2;

const internalIdHealth: Array.NonEmptyReadonlyArray<(rng: Random) => Sample> = pipe(
	internalOnly,
	Array.map((carrier) => (rng: Random): Sample => {
		const record = {
			diagnosis: rng.pick(diagnoses),
			fields: [],
			internalId: rng.between(firstPatientId, lastPatientId),
			lang: "en",
		} as const;

		const payload = carriers[carrier].render({ minified: rng.chance(minifiedShare), record, rng });

		return { payload, scene: carriers[carrier] };
	}),
);

export { internalIdHealth, internalIds, patientId };
