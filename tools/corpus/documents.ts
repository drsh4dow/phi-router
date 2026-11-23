import { Array, Record, pipe } from "effect";
import { healthLabels, identifierLabels, phrases } from "./labels.ts";
import type { ByLang } from "./people.ts";
import type { Random } from "./random.ts";
import type { RenderInput } from "./record.ts";
import { compactJson } from "./encodings.ts";

interface NoteFacts {
	readonly diagnosis: string;
	readonly code: string;
	readonly medication: string;
	readonly vitals: string;
}

type NoteBody = (facts: NoteFacts) => readonly string[];

const noteBodies: ByLang<NoteBody> = {
	de: ({ code, diagnosis, medication, vitals }) => [
		"Besuchsart: ambulante Verlaufskontrolle",
		"",
		"ANAMNESE:",
		`Wiedervorstellung zur Kontrolle bei ${diagnosis}. Nimmt ${medication} wie verordnet. Keine neuen Beschwerden.`,
		"",
		"BEFUND:",
		`${vitals}. Wach und orientiert.`,
		"",
		"BEURTEILUNG:",
		`${diagnosis} (${code}), unter aktueller Therapie stabil.`,
		"",
		"PROCEDERE:",
		`${medication} fortführen. Laborkontrolle vor dem nächsten Termin. Wiedervorstellung in 3 Monaten.`,
	],
	en: ({ code, diagnosis, medication, vitals }) => [
		"Visit type: outpatient follow-up",
		"",
		"SUBJECTIVE:",
		`Returns for follow-up of ${diagnosis}. Reports taking ${medication} as prescribed. No new complaints.`,
		"",
		"OBJECTIVE:",
		`${vitals}. Alert and oriented.`,
		"",
		"ASSESSMENT:",
		`${diagnosis} (${code}), stable on current regimen.`,
		"",
		"PLAN:",
		`Continue ${medication}. Repeat labs before next visit. Return in 3 months.`,
	],
	es: ({ code, diagnosis, medication, vitals }) => [
		"Tipo de visita: control ambulatorio",
		"",
		"SUBJETIVO:",
		`Acude a control de ${diagnosis}. Refiere tomar ${medication} según indicación. Sin quejas nuevas.`,
		"",
		"OBJETIVO:",
		`${vitals}. Consciente y orientado.`,
		"",
		"EVALUACIÓN:",
		`${diagnosis} (${code}), estable con el tratamiento actual.`,
		"",
		"PLAN:",
		`Continuar ${medication}. Repetir analítica antes de la próxima visita. Control en 3 meses.`,
	],
	fr: ({ code, diagnosis, medication, vitals }) => [
		"Type de visite : suivi en consultation",
		"",
		"SUBJECTIF :",
		`Revient pour le suivi de : ${diagnosis}. Dit prendre ${medication} comme prescrit. Pas de nouvelle plainte.`,
		"",
		"OBJECTIF :",
		`${vitals}. Conscient et orienté.`,
		"",
		"ÉVALUATION :",
		`${diagnosis} (${code}), stable sous traitement actuel.`,
		"",
		"PLAN :",
		`Poursuivre ${medication}. Bilan biologique avant la prochaine visite. Revoir dans 3 mois.`,
	],
	pt: ({ code, diagnosis, medication, vitals }) => [
		"Tipo de consulta: retorno ambulatorial",
		"",
		"SUBJETIVO:",
		`Retorna para acompanhamento de ${diagnosis}. Refere uso de ${medication} conforme prescrito. Sem queixas novas.`,
		"",
		"OBJETIVO:",
		`${vitals}. Lúcido e orientado.`,
		"",
		"AVALIAÇÃO:",
		`${diagnosis} (${code}), estável com o tratamento atual.`,
		"",
		"PLANO:",
		`Manter ${medication}. Repetir exames antes do próximo retorno. Retorno em 3 meses.`,
	],
	vi: ({ code, diagnosis, medication, vitals }) => [
		"Loại khám: tái khám ngoại trú",
		"",
		"CHỦ QUAN:",
		`Tái khám theo dõi ${diagnosis}. Dùng ${medication} theo đơn. Không có triệu chứng mới.`,
		"",
		"KHÁCH QUAN:",
		`${vitals}. Tỉnh táo.`,
		"",
		"ĐÁNH GIÁ:",
		`${diagnosis} (${code}), ổn định với điều trị hiện tại.`,
		"",
		"KẾ HOẠCH:",
		`Tiếp tục ${medication}. Xét nghiệm lại trước lần khám tới. Tái khám sau 3 tháng.`,
	],
};

const identifierLines = ({ record }: RenderInput): string[] => [
	`Patient ID: ${String(record.rowId)}`,
	...pipe(
		record.fields,
		Array.map(({ kind, value }) => `${identifierLabels[kind][record.lang]}: ${value}`),
	),
];

const vitalSigns = (rng: Random): string => {
	const lowestSystolic = 108;
	const highestSystolic = 162;
	const lowestDiastolic = 64;
	const highestDiastolic = 96;
	const lowestHeartRate = 58;
	const highestHeartRate = 104;

	return `BP ${String(rng.between(lowestSystolic, highestSystolic))}/${String(rng.between(lowestDiastolic, highestDiastolic))}, HR ${String(rng.between(lowestHeartRate, highestHeartRate))}`;
};

const clinicalNote = (input: RenderInput): string => {
	const { record, rng, minified } = input;
	const { lang, diagnosis } = record;

	const body = noteBodies[lang]({
		code: diagnosis.code,
		diagnosis: diagnosis.text[lang],
		medication: diagnosis.medication[lang],
		vitals: vitalSigns(rng),
	});

	const text = Array.join([...identifierLines(input), ...body], "\n");

	if (minified) {
		return compactJson({ noteType: "progress", status: "final", text });
	}

	return text;
};

const recordLines = (input: RenderInput): string[] => {
	const { lang, diagnosis } = input.record;

	return [
		...identifierLines(input),
		`${healthLabels.diagnosis[lang]}: ${diagnosis.code} ${diagnosis.text[lang]}`,
		`${healthLabels.medication[lang]}: ${diagnosis.medication[lang]}`,
	];
};

const ticket = (input: RenderInput): string => {
	const lowestTicketId = 20_000;
	const highestTicketId = 89_999;
	const { record, rng, minified } = input;
	const id = rng.between(lowestTicketId, highestTicketId);
	const subject = phrases.ticketSubject[record.lang];
	const description = Array.join([phrases.ticketBody[record.lang], "", ...recordLines(input)], "\n");

	if (minified) {
		return compactJson({
			ticket: Record.fromEntries([
				["id", id],
				["subject", subject],
				["status", "open"],
				["priority", "high"],
				["description", description],
			]),
		});
	}

	return Array.join(
		[
			`Ticket #${String(id)} (priority: high, status: open)`,
			`Subject: ${subject}`,
			"Requester: front desk, Northfield Clinic",
			"",
			description,
		],
		"\n",
	);
};

export { clinicalNote, ticket };
