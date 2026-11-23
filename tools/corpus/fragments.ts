import type { Sample, Scene } from "./conversation.ts";
import { systemTime, two } from "./record.ts";
import { Array } from "effect";
import type { Random } from "./random.ts";
import { drawName } from "./people.ts";
import { patientId } from "./internal-ids.ts";

const identityScene: Scene = {
	asks: [
		"Identity verification fails for some callers. What do these logs show?",
		"Why does the verify step reject this one?",
	],
	commands: ["kubectl logs deploy/identity-verify --since=15m | tail -n 3"],
	paths: ["logs/identity-verify.log"],
};

const logged = (rng: Random, line: string): string => {
	const sessionIdLength = 12;

	return Array.join(
		[
			`${systemTime(rng)} INFO  verify session=${rng.hex(sessionIdLength)} started`,
			`${systemTime(rng)} WARN  ${line}`,
			`${systemTime(rng)} INFO  verify session closed`,
		],
		"\n",
	);
};

const maskedSsn = (rng: Random): Sample => {
	const lastDigits = 4;
	const masked = `***-**-${rng.digits(lastDigits)}`;

	return {
		fragments: [masked],
		payload: logged(rng, `verify patient_id=${patientId(rng)} ssn=${masked} method=kba result=mismatch`),
		scene: identityScene,
	};
};

const ssnPrefix = (rng: Random): Sample => {
	const lowestUnissuedArea = 900;
	const highestArea = 999;
	const lowestGroup = 1;
	const highestGroup = 99;
	const prefix = `${String(rng.between(lowestUnissuedArea, highestArea))}-${two(rng.between(lowestGroup, highestGroup))}`;

	return {
		fragments: [prefix],
		payload: logged(
			rng,
			`verify patient_id=${patientId(rng)} rejected: ssn prefix "${prefix}" is outside the issued range`,
		),
		scene: identityScene,
	};
};

const birthDateOf = (rng: Random): string => {
	const earliestYear = 1934;
	const latestYear = 2006;
	const january = 1;
	const december = 12;
	const firstDay = 1;
	const lastDayInEveryMonth = 28;

	return `${String(rng.between(earliestYear, latestYear))}-${two(rng.between(january, december))}-${two(rng.between(firstDay, lastDayInEveryMonth))}`;
};

const birthDateAlone = (rng: Random): Sample => {
	const birthDate = birthDateOf(rng);

	return {
		fragments: [birthDate],
		payload: `${systemTime(rng)} eligibility patient_id=${patientId(rng)} dob=${birthDate} plan=CMHP01 result=inactive`,
		scene: {
			asks: ["Eligibility comes back inactive for this one. Is the date format the problem?"],
			commands: ["grep patient_id logs/eligibility.log | tail -n 1"],
			paths: ["logs/eligibility.log"],
		},
	};
};

/**
 * A given name of six letters or more, so it is long enough to track.
 *
 * @param {Random} rng The draw source.
 * @returns {string} The given name.
 */
const givenName = (rng: Random): string => {
	const shortestTrackable = 6;
	const { given } = drawName("en")(rng);

	if (given.length >= shortestTrackable) {
		return given;
	}

	return givenName(rng);
};

const firstNameOnly = (rng: Random): Sample => {
	const ticketDigits = 5;
	const given = givenName(rng);

	return {
		fragments: [given],
		payload: Array.join(
			[
				`Ticket #${rng.digits(ticketDigits)} (callbacks)`,
				`Voicemail from ${given}, first name only, asking about a claim status.`,
				`Internal ref: patient_id ${patientId(rng)}`,
			],
			"\n",
		),
		scene: {
			asks: ["Can you link this voicemail ticket to the right record in our tracker?"],
			commands: ["zd ticket show --latest --queue callbacks"],
			paths: ["support/tickets/callback-latest.txt"],
		},
	};
};

const memberPrefix = (rng: Random): Sample => {
	const prefixLetters = 3;
	const prefixDigits = 3;
	const prefix = `${rng.chars("ABCDEFGHJKLMNPRSTUVWXYZ", prefixLetters)}${rng.digits(prefixDigits)}`;

	return {
		fragments: [prefix],
		payload: `${systemTime(rng)} claim accepted patient_id=${patientId(rng)} member_id=${prefix}****** payer=60054`,
		scene: {
			asks: ["The masking helper leaves the first six characters. Is that what this log shows?"],
			commands: ["grep member_id logs/claims-worker.log | tail -n 1"],
			paths: ["logs/claims-worker.log"],
		},
	};
};

const streetOnly = (rng: Random): Sample => {
	const zipPrefixDigits = 3;
	const street = `${drawName("en")(rng).family} ${rng.pick(["Ave", "Street", "Road", "Lane"])}`;

	return {
		fragments: [street],
		payload: `${systemTime(rng)} geocode miss patient_id=${patientId(rng)} street="${street}" zip3=${rng.digits(zipPrefixDigits)}`,
		scene: {
			asks: ["The geocoder misses a lot of addresses. Is it the street suffix?"],
			commands: ["grep 'geocode miss' logs/geocoder.log | tail -n 1"],
			paths: ["logs/geocoder.log"],
		},
	};
};

export const fragmentSamples: Array.NonEmptyReadonlyArray<(rng: Random) => Sample> = [
	maskedSsn,
	ssnPrefix,
	birthDateAlone,
	firstNameOnly,
	memberPrefix,
	streetOnly,
];
