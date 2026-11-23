import { Array, Number as Num, Option, Record, String as Str, pipe } from "effect";
import type { Carrier, TextIdentifier } from "./manifest.ts";
import type { Lang, PersonName } from "./people.ts";
import { ascii, drawName, fullName } from "./people.ts";
import { dayOfMonth, month, two } from "./record.ts";
import type { Random } from "./random.ts";
import { identifierKind } from "#router/features/policy/index.ts";

interface DrawContext {
	readonly rng: Random;
	readonly lang: Lang;
	readonly carrier: typeof Carrier.Type;
}

type Draw = (context: DrawContext) => string;

/** The alphabet each symbol of a format stands for. Any other character stands for itself. */
type Symbols = Readonly<Record<string, string>>;

const digits = "0123456789";

const nonzeroDigits = "123456789";

const letters = "ABCDEFGHJKLMNPRSTUVWXYZ";

/** `#` a digit, `^` a nonzero digit, `@` a letter, `*` a letter or a digit. */
const symbols: Symbols = { "#": digits, "*": `${letters}${digits}`, "@": letters, "^": nonzeroDigits };

/** A Medicare Beneficiary Identifier's letters, which skip S, L, O, I, B and Z. */
const mbiLetters = "ACDEFGHJKMNPQRTUVWXY";

const mbiSymbols: Symbols = { "#": digits, "*": `${mbiLetters}${digits}`, "@": mbiLetters, "^": nonzeroDigits };

const oneCharacter = 1;

/** The street numbers drawn, and the smaller ranges some languages' addresses fold them into. */
const streetNumbers = { de: 200, fr: 300, max: 9890, min: 12, vi: 500 } as const;

const birthYears = { max: 2006, min: 1934 } as const;

/** How often an English record writes a date of birth as ISO instead of `MM/DD/YYYY`. */
const englishIsoShare = 0.4;

/** SSN areas 900 to 999 and 666 were never issued. 666 takes `area666Share` of the draws. */
const ssn = { area666Share: 0.15, areas: { max: 999, min: 900 }, groups: { max: 99, min: 1 } } as const;

const ssnSerials = { digits: 4, max: 9999, min: 1 } as const;

/** How often a Medicare or Medicaid number is an MBI rather than a Medicaid client id in New York's two letters, five digits and a letter. */
const mbiShare = 0.6;

/** How often a passport number starts with a letter rather than a 5. */
const letterPassportShare = 0.5;

/**
 * Draws a value in `format`, one character at a time, left to right.
 *
 * @param {Symbols} alphabets What each symbol of the format stands for.
 * @returns {(rng: Random, format: string) => string} Draws a value.
 */
const formatIn =
	(alphabets: Symbols) =>
	(rng: Random, format: string): string =>
		pipe(
			Array.fromIterable(format),
			Array.map((char) =>
				Option.match(Record.get(alphabets, char), {
					onNone: () => char,
					onSome: (alphabet) => rng.chars(alphabet, oneCharacter),
				}),
			),
			Array.join(""),
		);

const formatted = formatIn(symbols);

const nameIn =
	(carrier: typeof Carrier.Type) =>
	(name: PersonName): string => {
		if (carrier === "hl7v2") {
			return `${name.family}^${name.given}`;
		}

		if (carrier === "x12-837") {
			return Str.toUpperCase(`${ascii(name.family)}*${ascii(name.given)}`);
		}

		if (carrier === "file-name") {
			return `${name.family}, ${name.given}`;
		}

		return fullName(name);
	};

const nameValue: Draw = ({ rng, lang, carrier }) => nameIn(carrier)(drawName(lang)(rng));

const streetValue: Draw = ({ rng, lang }) => {
	const street = drawName(lang)(rng);
	const number = rng.between(streetNumbers.min, streetNumbers.max);

	const forms = {
		de: `${street.family}straße ${String(Num.increment(number % streetNumbers.de))}`,
		en: `${String(number)} ${street.family} ${rng.pick(["Ave", "St", "Rd", "Ln", "Ct", "Dr"])}`,
		es: `Calle ${street.family} ${String(number)}`,
		fr: `${String(Num.increment(number % streetNumbers.fr))} rue ${street.family}`,
		pt: `Rua ${street.family}, ${String(number)}`,
		vi: `${String(Num.increment(number % streetNumbers.vi))} đường ${fullName(street)}`,
	};

	return forms[lang];
};

const dateValue: Draw = ({ rng, lang, carrier }) => {
	const [year, monthOfYear, day] = [String(rng.between(birthYears.min, birthYears.max)), month(rng), dayOfMonth(rng)];

	if (carrier === "hl7v2" || carrier === "x12-837") {
		return `${year}${monthOfYear}${day}`;
	}

	if (carrier === "fhir-json" || carrier === "file-name" || (lang === "en" && rng.chance(englishIsoShare))) {
		return `${year}-${monthOfYear}-${day}`;
	}

	if (lang === "en") {
		return `${monthOfYear}/${day}/${year}`;
	}

	if (lang === "de") {
		return `${day}.${monthOfYear}.${year}`;
	}

	return `${day}/${monthOfYear}/${year}`;
};

/** Any area code but 503, the staff contacts' area code, so no personal phone is also a staff line. */
const areaCodes: Array.NonEmptyReadonlyArray<string> = ["971", "614", "412", "720", "919", "602", "786", "347"];

/** 555-0100 to 555-0199 is reserved for fiction in every area code, so no drawn phone is a subscriber's. */
const exchange = "555";

const fictionLineDigits = 2;

const phoneValue: Draw = ({ rng, lang, carrier }) => {
	const area = rng.pick(areaCodes);
	const line = `01${rng.digits(fictionLineDigits)}`;

	if (carrier === "x12-837" || carrier === "file-name") {
		return `${area}${exchange}${line}`;
	}

	if (carrier === "hl7v2") {
		return `(${area})${exchange}-${line}`;
	}

	if (lang === "en") {
		return rng.pick([`(${area}) ${exchange}-${line}`, `${area}-${exchange}-${line}`]);
	}

	return `+1 ${area} ${exchange} ${line}`;
};

const emailValue: Draw = ({ rng, lang }) => {
	const name = drawName(lang)(rng);
	const local = Str.toLowerCase(ascii(`${name.given}${rng.pick([".", "_", ""])}${name.family}`));
	const domain = rng.pick(["mail.example.org", "post.example.net", "fernpost.example", "quillmail.example"]);

	return `${Str.replaceAll(" ", "")(local)}${formatted(rng, "##")}@${domain}`;
};

const ssnArea = (rng: Random): string => {
	if (rng.chance(ssn.area666Share)) {
		return "666";
	}

	return String(rng.between(ssn.areas.min, ssn.areas.max));
};

const ssnValue: Draw = ({ rng, carrier }) => {
	const area = ssnArea(rng);
	const group = two(rng.between(ssn.groups.min, ssn.groups.max));
	const serial = Str.padStart(ssnSerials.digits, "0")(String(rng.between(ssnSerials.min, ssnSerials.max)));

	if (carrier === "x12-837") {
		return `${area}${group}${serial}`;
	}

	return `${area}-${group}-${serial}`;
};

const medicareMedicaidValue: Draw = ({ rng }) => {
	if (rng.chance(mbiShare)) {
		return formatIn(mbiSymbols)(rng, "^@*#@*#@@##");
	}

	return formatted(rng, "@@#####@");
};

const passportValue: Draw = ({ rng }) => {
	if (rng.chance(letterPassportShare)) {
		return formatted(rng, "@########");
	}

	return formatted(rng, "5########");
};

const driverLicenseValue: Draw = ({ rng }) =>
	rng.pick([
		formatted(rng, "@#######"),
		formatted(rng, "WDL*********"),
		formatted(rng, "### ### ###"),
		formatted(rng, "@###-###-##-###-#"),
	]);

const mrnValue: Draw = ({ rng }) =>
	rng.pick([formatted(rng, "E#######"), formatted(rng, "^########"), formatted(rng, "MR########")]);

const memberNumberValue: Draw = ({ rng }) => formatted(rng, "@@@#########");

const draws = {
	[identifierKind.birthDate]: dateValue,
	[identifierKind.driverLicense]: driverLicenseValue,
	[identifierKind.medicalRecordNumber]: mrnValue,
	[identifierKind.medicareMedicaidNumber]: medicareMedicaidValue,
	[identifierKind.memberNumber]: memberNumberValue,
	[identifierKind.passportNumber]: passportValue,
	[identifierKind.patientName]: nameValue,
	[identifierKind.personalEmail]: emailValue,
	[identifierKind.personalPhone]: phoneValue,
	[identifierKind.socialSecurityNumber]: ssnValue,
	[identifierKind.streetAddress]: streetValue,
} satisfies Record<TextIdentifier, Draw>;

const drawIdentifier = (kind: TextIdentifier): Draw => draws[kind];

export { drawIdentifier, nameIn };

export type { DrawContext };
