import { Array, String as Str } from "effect";
import { drawName, fullName, slug } from "./people.ts";
import type { Random } from "./random.ts";
import type { Sample } from "./conversation.ts";

interface Contact {
	readonly name: string;
	readonly email: string;
	readonly phone: string;
}

const contact = (rng: Random, domain: string): Contact => {
	const lineDigits = 2;
	const name = fullName(drawName("en")(rng));

	return { email: `${slug(".")(name)}@${domain}`, name, phone: `(503) 555-01${rng.digits(lineDigits)}` };
};

const staff = "northfield-health.example";

const onCall = (rng: Random): Sample => {
	const [primary, secondary] = [contact(rng, staff), contact(rng, staff)];

	return {
		payload: Array.join(
			[
				"rotation: claims-platform",
				"handoff: monday 09:00 America/Los_Angeles",
				"primary:",
				`  name: ${primary.name}`,
				`  email: ${primary.email}`,
				`  phone: "${primary.phone}"`,
				"secondary:",
				`  name: ${secondary.name}`,
				`  email: ${secondary.email}`,
				`  phone: "${secondary.phone}"`,
				"escalation_minutes: 15",
			],
			"\n",
		),
		scene: {
			asks: [
				"Add a third engineer to this rotation and fix the indentation.",
				"Why does PagerDuty reject this rota file?",
			],
			commands: ["cat ops/oncall/claims-platform.yml"],
			paths: ["ops/oncall/claims-platform.yml"],
		},
	};
};

const vendorEmail = (rng: Random): Sample => {
	const vendor = contact(rng, "clearstream-edi.example");
	const engineer = contact(rng, staff);
	const batchDigits = 4;
	const batch = rng.digits(batchDigits);

	return {
		payload: Array.join(
			[
				`From: ${vendor.name} <${vendor.email}>`,
				`To: ${engineer.name} <${engineer.email}>`,
				`Subject: Re: 999 rejects on batch ${batch}`,
				"",
				`Hi ${Array.headNonEmpty(Str.split(" ")(engineer.name))},`,
				"",
				`Batch ${batch} failed SNIP level 2 again: the GS08 version is 005010X222 without the A1 suffix.`,
				"Once you regenerate it, resubmit and I'll watch the queue.",
				"",
				"Regards,",
				vendor.name,
				"Integration Engineer, Clearstream EDI",
				`Direct: ${vendor.phone}`,
			],
			"\n",
		),
		scene: {
			asks: [
				"The clearinghouse sent this about our rejects. What do they want us to change?",
				"Draft a reply to this vendor email.",
			],
			commands: ["cat support/vendor/clearstream-latest.eml"],
			paths: ["support/vendor/clearstream-latest.eml"],
		},
	};
};

const contacts = (rng: Random): Sample => {
	const fewestRows = 3;
	const mostRows = 5;

	const rows = Array.makeBy(rng.between(fewestRows, mostRows), () => {
		const person = contact(rng, staff);

		const role = rng.pick([
			"Billing lead",
			"Integration engineer",
			"Clinic manager",
			"Data steward",
			"Front desk lead",
		]);

		return `| ${person.name} | ${role} | ${person.email} | ${person.phone} |`;
	});

	return {
		payload: Array.join(["| Name | Role | Email | Phone |", "| --- | --- | --- | --- |", ...rows], "\n"),
		scene: {
			asks: ["Turn this contact table into a CODEOWNERS file.", "Sort this escalation list by role."],
			commands: ["cat docs/CONTACTS.md"],
			paths: ["docs/CONTACTS.md"],
		},
	};
};

const authorLine = (rng: Random): string => {
	const commitCountWidth = 6;
	const fewestCommits = 2;
	const mostCommits = 180;
	const person = contact(rng, staff);

	return `${Str.padStart(commitCountWidth)(String(rng.between(fewestCommits, mostCommits)))}\t${person.name} <${person.email}>`;
};

const gitAuthors = (rng: Random): Sample => {
	const fewestAuthors = 3;
	const mostAuthors = 6;

	return {
		payload: Array.join(
			Array.makeBy(rng.between(fewestAuthors, mostAuthors), () => authorLine(rng)),
			"\n",
		),
		scene: {
			asks: ["Who should review changes to the mapper, going by this?", "Dedupe these authors for the changelog."],
			commands: ["git shortlog -sne -- src/mapper"],
			paths: [".mailmap"],
		},
	};
};

const submitter = (rng: Random): Sample => {
	const desk = contact(rng, staff);
	const controlDigits = 9;
	const submitterDigits = 5;
	const control = rng.digits(controlDigits);

	return {
		payload: Array.join(
			[
				`ISA*00*          *00*          *ZZ*NORTHFIELD     *ZZ*CLEARSTREAM    *250304*0215*^*00501*${control}*0*P*:~`,
				"GS*HC*NORTHFIELD*CLEARSTREAM*20250304*0215*1*X*005010X222A1~",
				"ST*837*0001*005010X222A1~",
				`NM1*41*2*NORTHFIELD BILLING*****46*S${rng.digits(submitterDigits)}~`,
				`PER*IC*${Str.toUpperCase(desk.name)}*TE*${Str.replaceAll(/\D/gu, "")(desk.phone)}*EM*${desk.email}~`,
				"NM1*40*2*CLEARSTREAM EDI*****46*CSE0042~",
			],
			"\n",
		),
		scene: {
			asks: ["The payer bounces this 837 header. Is the submitter loop right?"],
			commands: ["head -n 6 out/edi/837P_latest.edi"],
			paths: ["out/edi/837P_latest.edi"],
		},
	};
};

export const staffContacts: Array.NonEmptyReadonlyArray<(rng: Random) => Sample> = [
	onCall,
	vendorEmail,
	contacts,
	gitAuthors,
	submitter,
];
