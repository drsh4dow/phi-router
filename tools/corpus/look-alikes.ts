import { Array, String as Str, pipe } from "effect";
import { two, uuid } from "./record.ts";
import type { Random } from "./random.ts";
import type { Sample } from "./conversation.ts";

const firstMonth = 1;
const lastMonth = 12;
const firstDay = 1;
const lastDayInEveryMonth = 28;
const hoursPerDay = 24;
const minutesPerHour = 60;

const month = (rng: Random): string => two(rng.between(firstMonth, lastMonth));

const day = (rng: Random): string => two(rng.between(firstDay, lastDayInEveryMonth));

const hour = (rng: Random): string => two(rng.int(hoursPerDay));

const minuteOrSecond = (rng: Random): string => two(rng.int(minutesPerHour));

const isoTime = (rng: Random): string =>
	`2025-${month(rng)}-${day(rng)}T${hour(rng)}:${minuteOrSecond(rng)}:${minuteOrSecond(rng)}Z`;

const firstMajor = 1;
const lastMajor = 9;
const firstMinor = 0;
const lastMinor = 30;
const firstPatch = 0;
const lastPatch = 20;

const semver = (rng: Random): string =>
	`${String(rng.between(firstMajor, lastMajor))}.${String(rng.between(firstMinor, lastMinor))}.${String(rng.between(firstPatch, lastPatch))}`;

const buildCounterDigits = 4;
const runIdDigits = 10;
const imageIdLength = 12;
const firstReleaseCandidate = 1;
const lastReleaseCandidate = 6;
const buildNumberDigits = 8;
const sha256HexLength = 64;
const smallestImageSize = 1000;
const largestImageSize = 9000;
const replicaSetHashLength = 10;
const startedMinute = 1;
const copiedMinute = 4;
const builtMinute = 7;
const taggedMinute = 8;
const pushedMinute = 9;
const deadlineMinute = 19;

const ciLog = (rng: Random): Sample => {
	const [monthDrawn, dayDrawn, hourDrawn] = [month(rng), day(rng), hour(rng)];
	const build = `2025.${monthDrawn}.${dayDrawn}-${rng.digits(buildCounterDigits)}`;
	const version = semver(rng);

	const at = (minute: number): string =>
		`2025-${monthDrawn}-${dayDrawn}T${hourDrawn}:${two(minute)}:${minuteOrSecond(rng)}Z`;

	const runId = rng.digits(runIdDigits);

	return {
		payload: Array.join(
			[
				`${at(startedMinute)} Build #${build} started for claims-api@${version}`,
				`${at(copiedMinute)} Step 7/12 : COPY --from=builder /app/dist /srv`,
				`${at(builtMinute)} Successfully built ${rng.hex(imageIdLength)}`,
				`${at(taggedMinute)} Tagged registry.internal/claims-api:${version}-rc.${String(rng.between(firstReleaseCandidate, lastReleaseCandidate))}+build.${rng.digits(buildNumberDigits)}`,
				`${at(pushedMinute)} digest: sha256:${rng.hex(sha256HexLength)} size: ${String(rng.between(smallestImageSize, largestImageSize))}`,
				`${at(deadlineMinute)} Error: deployment "claims-api" exceeded its progress deadline (ReplicaSet claims-api-${rng.hex(replicaSetHashLength)})`,
			],
			"\n",
		),
		scene: {
			asks: [
				"The deploy step fails after the image push. What's wrong?",
				"Why did this pipeline tag the wrong version?",
			],
			commands: [`gh run view ${runId} --log-failed`],
			paths: ["ci-logs/deploy.log"],
		},
	};
};

const commitHashLength = 40;

const gitLog = (rng: Random): Sample => ({
	payload: pipe(
		[
			"fix(edi): accept 5010 trailers",
			"chore: bump deps",
			"feat(270): parse EB segments",
			"test: cover AAA rejects",
			"refactor: split mapper",
			"ci: cache bun",
		],
		Array.map((subject) => `${rng.hex(commitHashLength)} ${isoTime(rng)} ${subject}`),
		Array.join("\n"),
	),
	scene: {
		asks: ["Which of these commits broke the eligibility parser?", "Squash these into one release commit message."],
		commands: ["git log --format='%H %aI %s' -6"],
		paths: [".git/logs/HEAD"],
	},
});

const packages = ["hl7v2", "node-x12", "zod", "pino", "fastify", "kysely", "date-fns"];

const integrityLength = 86;
const packagesChanged = 4;

const lockfile = (rng: Random): Sample => {
	const entry = (name: string): readonly string[] => [
		`    "node_modules/${name}": {`,
		`      "version": "${semver(rng)}",`,
		`      "integrity": "sha512-${rng.chars("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/", integrityLength)}=="`,
		"    },",
	];

	const changed = Array.take(rng.shuffle(packages), packagesChanged);

	return {
		payload: pipe(
			changed,
			Array.flatMap((name) => entry(name)),
			Array.join("\n"),
		),
		scene: {
			asks: ["npm ci fails with an integrity error. Which package is it?", "Why did this lockfile change so much?"],
			commands: ["git diff HEAD~1 -- package-lock.json | head -40"],
			paths: ["package-lock.json"],
		},
	};
};

const labelerDigits = 5;
const shortestProductDigits = 3;
const productLengths = 2;
const packageDigits = 2;
const fewestNdcRows = 4;
const mostNdcRows = 7;
const fewestTablets = 30;
const mostTablets = 500;
const lotPrefixLength = 2;
const lotDigits = 6;

const ndcCodes = (rng: Random): Sample => {
	const ndc = (): string =>
		`${rng.digits(labelerDigits)}-${rng.digits(shortestProductDigits + rng.int(productLengths))}-${rng.digits(packageDigits)}`;

	return {
		payload: Array.join(
			[
				"ndc,package_description,lot,expires",
				...Array.makeBy(
					rng.between(fewestNdcRows, mostNdcRows),
					() =>
						`${ndc()},${String(rng.between(fewestTablets, mostTablets))} TABLET in 1 BOTTLE,${rng.chars("ABCDEFGHJKLMNPRSTUVWXYZ", lotPrefixLength)}${rng.digits(lotDigits)},2026-${month(rng)}`,
				),
			],
			"\n",
		),
		scene: {
			asks: [
				"The formulary import rejects some NDCs. Is it the 4-4-2 vs 5-3-2 normalisation?",
				"Write a normaliser for these NDC formats to 11 digits.",
			],
			commands: ["head -8 data/formulary/ndc_import.csv"],
			paths: ["data/formulary/ndc_import.csv"],
		},
	};
};

const messageControlDigits = 8;

const hl7Ack = (rng: Random): Sample => {
	const stamp = Str.replaceAll(/\D/gu, "")(isoTime(rng));

	return {
		payload: Array.join(
			[
				`MSH|^~\\&|INTEGRATION|ETL|EPICADT|NFH|${stamp}||ACK^A01^ACK|ACK${rng.digits(messageControlDigits)}|P|2.5.1`,
				`MSA|AA|MSG${rng.digits(messageControlDigits)}`,
			],
			"\r",
		),
		scene: {
			asks: [
				"The sender keeps resending after our ACK. Is the ACK malformed?",
				"Why does the interface engine treat this ACK as an error?",
			],
			commands: ["tail -3 /var/log/mirth/outbound-acks.log"],
			paths: ["samples/acks/last.hl7"],
		},
	};
};

const interchangeControlDigits = 9;
const timeDigits = 4;
const groupControlDigits = 4;

const x12Ack = (rng: Random): Sample => {
	const control = rng.digits(interchangeControlDigits);

	return {
		payload: Array.join(
			[
				`ISA*00*          *00*          *ZZ*CLEARSTREAM    *ZZ*NORTHFIELD     *25${month(rng)}${day(rng)}*${rng.digits(timeDigits)}*^*00501*${control}*0*P*:~`,
				`GS*FA*CLEARSTREAM*NORTHFIELD*2025${month(rng)}${day(rng)}*${rng.digits(timeDigits)}*${rng.digits(groupControlDigits)}*X*005010X231A1~`,
				`ST*999*0001*005010X231A1~`,
				`AK1*HC*${rng.digits(groupControlDigits)}*005010X222A1~`,
				`AK2*837*0001*005010X222A1~`,
				`IK5*A~`,
				`AK9*A*1*1*1~`,
				`SE*6*0001~`,
				`GE*1*${rng.digits(groupControlDigits)}~`,
				`IEA*1*${control}~`,
			],
			"\n",
		),
		scene: {
			asks: ["Is this 999 an accept or a reject? The dashboard says pending.", "Parse this 999 into our ack table."],
			commands: ["cat inbound/999/latest.edi"],
			paths: ["inbound/999/latest.edi"],
		},
	};
};

const fewestEvents = 3;
const mostEvents = 6;
const accountIdDigits = 12;
const buildHashLength = 7;
const fastestMs = 3;
const slowestMs = 2000;

const cloudEvents = (rng: Random): Sample => ({
	payload: Array.join(
		Array.makeBy(
			rng.between(fewestEvents, mostEvents),
			() =>
				`{"ts":"${isoTime(rng)}","level":"${rng.pick(["info", "warn", "error"])}","request_id":"${uuid(rng)}","account":"${rng.digits(accountIdDigits)}","build":"${semver(rng)}+${rng.hex(buildHashLength)}","latency_ms":${String(rng.between(fastestMs, slowestMs))}}`,
		),
		"\n",
	),
	scene: {
		asks: [
			"Which request failed in this trace? The ids all look alike to me.",
			"Correlate these events by request id.",
		],
		commands: ["aws logs tail /ecs/claims-api --since 10m"],
		paths: ["logs/claims-api.jsonl"],
	},
});

const lookAlikes: Array.NonEmptyReadonlyArray<(rng: Random) => Sample> = [
	ciLog,
	gitLog,
	lockfile,
	ndcCodes,
	hl7Ack,
	x12Ack,
	cloudEvents,
];

export { lookAlikes };
