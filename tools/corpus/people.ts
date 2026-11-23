import { String as Str, pipe } from "effect";
import type { Array } from "effect";
import type { Random } from "./random.ts";

type Lang = "en" | "es" | "de" | "fr" | "pt" | "vi";

type ByLang<Value> = Readonly<Record<Lang, Value>>;

const foreignLangs: Array.NonEmptyReadonlyArray<Lang> = ["es", "de", "fr", "pt", "vi"];

type Syllables = Array.NonEmptyReadonlyArray<string>;

interface NameParts {
	readonly givenStarts: Syllables;
	readonly givenEnds: Syllables;
	readonly familyStarts: Syllables;
	readonly familyEnds: Syllables;
	/** What goes between a given name's two syllables. */
	readonly givenSeparator: string;
}

const parts = {
	de: {
		familyEnds: ["mann", "ler", "berger", "hof", "bach", "inger", "stein", "rath"],
		familyStarts: ["Brau", "Kess", "Lind", "Stoll", "Wern", "Holz", "Falk", "Rieg", "Mahl", "Dorn"],
		givenEnds: ["trud", "degard", "bert", "sel", "mar", "rike", "helm", "wig"],
		givenSeparator: "",
		givenStarts: ["Ger", "Hil", "Wal", "Lie", "Fri", "Ul", "Ans", "Ott", "Hel", "Rein"],
	},
	en: {
		familyEnds: ["anek", "ford", "ley", "mere", "wick", "stone", "berry", "ton", "well", "gard", "holt", "ridge"],
		familyStarts: ["Tov", "Quill", "Brann", "Hask", "Pell", "Strand", "Wick", "Ald", "Dunn", "Fenn", "Kest", "Thorn"],
		givenEnds: ["a", "ena", "iel", "on", "ia", "ett", "ard", "ine", "ley", "is", "wyn", "ora"],
		givenSeparator: "",
		givenStarts: ["Mar", "Tal", "Bren", "Cor", "Del", "Jor", "Kel", "Lor", "Nal", "Quin", "Ros", "Sel", "Vel", "Wyn"],
	},
	es: {
		familyEnds: ["ández", "ero", "alles", "illo", "aza", "edo", "ueña", "arro"],
		familyStarts: ["Gar", "Quin", "Bel", "Mon", "Tor", "Var", "Esc", "Lar", "Cav", "Zam"],
		givenEnds: ["ela", "isa", "iano", "ita", "ando", "encia", "ino", "una"],
		givenSeparator: "",
		givenStarts: ["Mar", "Lu", "Car", "Ro", "Fer", "Gua", "Ine", "Iso", "Ra", "Vale", "Eus", "Cle"],
	},
	fr: {
		familyEnds: ["ançon", "ollet", "èvre", "eau", "ier", "ault", "ette", "oux"],
		familyStarts: ["Ber", "Dum", "Lef", "Mor", "Rou", "Vau", "Char", "Delac", "Fon", "Gir"],
		givenEnds: ["élie", "édicte", "ément", "ton", "oïse", "ceau", "ange", "baut"],
		givenSeparator: "",
		givenStarts: ["Aur", "Bén", "Gas", "Hél", "Mar", "Sol", "Thi", "Év", "Lé", "Ros"],
	},
	pt: {
		familyEnds: ["rvalho", "dão", "reira", "sa", "ttos", "ixoto", "meida", "marães", "beiro"],
		familyStarts: ["Ca", "Bran", "Fer", "Sou", "Ma", "Pe", "Al", "Gui", "Ri", "Va"],
		givenEnds: ["ana", "rcia", "imundo", "esa", "ciana", "berto", "ina", "valdo"],
		givenSeparator: "",
		givenStarts: ["Jo", "Ma", "Ra", "Ter", "Lu", "Gil", "Cel", "Al", "Ro", "Dal"],
	},
	vi: {
		familyEnds: [""],
		familyStarts: ["Nguyễn", "Trần", "Lê", "Phạm", "Hoàng", "Huỳnh", "Võ", "Đặng", "Bùi", "Đỗ"],
		givenEnds: ["Khuê", "Lan", "Hải", "Phúc", "Tâm", "Long", "Yến", "Trung", "Nhung", "Vy"],
		givenSeparator: " ",
		givenStarts: ["Thị", "Văn", "Ngọc", "Minh", "Đức", "Thanh", "Quốc", "Hữu", "Bảo", "Gia"],
	},
} satisfies ByLang<NameParts>;

interface PersonName {
	readonly given: string;
	readonly family: string;
	readonly lang: Lang;
}

const drawName =
	(lang: Lang): ((rng: Random) => PersonName) =>
	(rng: Random): PersonName => {
		const { givenStarts, givenEnds, givenSeparator, familyStarts, familyEnds } = parts[lang];
		const given = `${rng.pick(givenStarts)}${givenSeparator}${rng.pick(givenEnds)}`;

		return { family: rng.pick(familyStarts) + rng.pick(familyEnds), given, lang };
	};

const fullName = ({ given, family, lang }: PersonName): string => {
	if (lang === "vi") {
		return `${family} ${given}`;
	}

	return `${given} ${family}`;
};

const ascii = (text: string): string =>
	pipe(text, Str.normalize("NFD"), Str.replaceAll(/\p{M}/gu, ""), Str.replaceAll("đ", "d"), Str.replaceAll("Đ", "D"));

const slug =
	(separator: string): ((text: string) => string) =>
	(text: string): string =>
		pipe(ascii(text), Str.toLowerCase, Str.replaceAll(/[^a-z0-9]+/gu, " "), Str.trim, Str.replaceAll(" ", separator));

export { ascii, drawName, foreignLangs, fullName, slug };

export type { ByLang, Lang, PersonName };
