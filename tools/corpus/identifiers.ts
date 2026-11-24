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

type Symbols = Readonly<Record<string, string>>;

const digits = "0123456789";

const nonzeroDigits = "123456789";

const letters = "ABCDEFGHJKLMNPRSTUVWXYZ";

const symbols: Symbols = { "#": digits, "*": `${letters}${digits}`, "@": letters, "^": nonzeroDigits };

const mbiLetters = "ACDEFGHJKMNPQRTUVWXY";

const mbiSymbols: Symbols = { "#": digits, "*": `${mbiLetters}${digits}`, "@": mbiLetters, "^": nonzeroDigits };

const oneCharacter = 1;

const streetNumbers = { foldedMaxIn: { de: 200, fr: 300, vi: 500 }, max: 9890, min: 12 } as const;

const birthYears = { max: 2006, min: 1934 } as const;

const englishIsoBirthDateShare = 0.4;

const ssn = { area666Share: 0.15, areas: { max: 999, min: 900 }, groups: { max: 99, min: 1 } } as const;

const ssnSerials = { digits: 4, max: 9999, min: 1 } as const;

const medicareMedicaidFormats = { mbi: "^@*#@*#@@##", newYorkMedicaidClientId: "@@#####@" } as const;

const mbiShareOfMedicareMedicaid = 0.6;

const letterFirstPassportShare = 0.5;

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
		de: `${street.family}straße ${String(Num.increment(number % streetNumbers.foldedMaxIn.de))}`,
		en: `${String(number)} ${street.family} ${rng.pick(["Ave", "St", "Rd", "Ln", "Ct", "Dr"])}`,
		es: `Calle ${street.family} ${String(number)}`,
		fr: `${String(Num.increment(number % streetNumbers.foldedMaxIn.fr))} rue ${street.family}`,
		pt: `Rua ${street.family}, ${String(number)}`,
		vi: `${String(Num.increment(number % streetNumbers.foldedMaxIn.vi))} đường ${fullName(street)}`,
	};

	return forms[lang];
};

const dateValue: Draw = ({ rng, lang, carrier }) => {
	const [year, monthOfYear, day] = [String(rng.between(birthYears.min, birthYears.max)), month(rng), dayOfMonth(rng)];

	if (carrier === "hl7v2" || carrier === "x12-837") {
		return `${year}${monthOfYear}${day}`;
	}

	if (carrier === "fhir-json" || carrier === "file-name" || (lang === "en" && rng.chance(englishIsoBirthDateShare))) {
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

const areaCodes: Array.NonEmptyReadonlyArray<string> = ["971", "614", "412", "720", "919", "602", "786", "347"];

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
	if (rng.chance(mbiShareOfMedicareMedicaid)) {
		return formatIn(mbiSymbols)(rng, medicareMedicaidFormats.mbi);
	}

	return formatted(rng, medicareMedicaidFormats.newYorkMedicaidClientId);
};

const passportValue: Draw = ({ rng }) => {
	if (rng.chance(letterFirstPassportShare)) {
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
