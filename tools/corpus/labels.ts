import type { ByLang } from "./people.ts";
import type { TextIdentifier } from "./manifest.ts";
import { identifierKind } from "#router/features/policy/index.ts";

const identifierLabels = {
	[identifierKind.birthDate]: {
		de: "Geburtsdatum",
		en: "Date of birth",
		es: "Fecha de nacimiento",
		fr: "Date de naissance",
		pt: "Data de nascimento",
		vi: "Ngày sinh",
	},
	[identifierKind.driverLicense]: {
		de: "Führerscheinnummer",
		en: "Driver license",
		es: "Licencia de conducir",
		fr: "Numéro de permis de conduire",
		pt: "Carteira de motorista",
		vi: "Số giấy phép lái xe",
	},
	[identifierKind.medicareMedicaidNumber]: {
		de: "Medicare-/Medicaid-Nummer",
		en: "Medicare/Medicaid ID",
		es: "Número de Medicare/Medicaid",
		fr: "Numéro Medicare/Medicaid",
		pt: "Número do Medicare/Medicaid",
		vi: "Mã số Medicare/Medicaid",
	},
	[identifierKind.memberNumber]: {
		de: "Versichertennummer",
		en: "Member ID",
		es: "Número de afiliado",
		fr: "Numéro d'adhérent",
		pt: "Número da carteirinha",
		vi: "Mã thẻ bảo hiểm",
	},
	[identifierKind.medicalRecordNumber]: {
		de: "Patientennummer",
		en: "MRN",
		es: "Número de historia clínica",
		fr: "Numéro de dossier patient",
		pt: "Número do prontuário",
		vi: "Mã hồ sơ bệnh án",
	},
	[identifierKind.passportNumber]: {
		de: "Reisepassnummer",
		en: "Passport number",
		es: "Número de pasaporte",
		fr: "Numéro de passeport",
		pt: "Número do passaporte",
		vi: "Số hộ chiếu",
	},
	[identifierKind.patientName]: {
		de: "Name des Patienten",
		en: "Patient name",
		es: "Nombre del paciente",
		fr: "Nom du patient",
		pt: "Nome do paciente",
		vi: "Họ tên bệnh nhân",
	},
	[identifierKind.personalEmail]: {
		de: "Private E-Mail",
		en: "Personal email",
		es: "Correo personal",
		fr: "Courriel personnel",
		pt: "E-mail pessoal",
		vi: "Email cá nhân",
	},
	[identifierKind.personalPhone]: {
		de: "Telefon privat",
		en: "Home phone",
		es: "Teléfono particular",
		fr: "Téléphone personnel",
		pt: "Telefone residencial",
		vi: "Số điện thoại nhà",
	},
	[identifierKind.socialSecurityNumber]: {
		de: "Sozialversicherungsnummer",
		en: "SSN",
		es: "Número de Seguro Social",
		fr: "Numéro de sécurité sociale",
		pt: "Número do Seguro Social",
		vi: "Số an sinh xã hội",
	},
	[identifierKind.streetAddress]: {
		de: "Wohnadresse",
		en: "Home address",
		es: "Domicilio",
		fr: "Adresse du domicile",
		pt: "Endereço residencial",
		vi: "Địa chỉ nhà",
	},
} satisfies Record<TextIdentifier, ByLang<string>>;

const healthLabels = {
	code: {
		de: "Diagnoseschlüssel",
		en: "Diagnosis code",
		es: "Código de diagnóstico",
		fr: "Code diagnostic",
		pt: "Código do diagnóstico",
		vi: "Mã chẩn đoán",
	},
	diagnosis: {
		de: "Diagnose",
		en: "Diagnosis",
		es: "Diagnóstico",
		fr: "Diagnostic",
		pt: "Diagnóstico",
		vi: "Chẩn đoán",
	},
	medication: {
		de: "Medikation",
		en: "Medication",
		es: "Medicamento",
		fr: "Traitement",
		pt: "Medicamento",
		vi: "Thuốc",
	},
} satisfies Record<string, ByLang<string>>;

const phrases = {
	rejected: {
		de: "Datensatz abgelehnt",
		en: "record rejected",
		es: "registro rechazado",
		fr: "enregistrement rejeté",
		pt: "registro rejeitado",
		vi: "bản ghi bị từ chối",
	},
	ticketBody: {
		de: "Hallo zusammen, die Abrechnung für diesen Patienten kam abgelehnt zurück, er hat zweimal angerufen. Kann jemand den Export prüfen?",
		en: "Hi team, the claim for this patient came back denied and they called twice. Can someone check the export?",
		es: "Hola equipo, el reclamo de este paciente volvió denegado y ya llamó dos veces. ¿Pueden revisar la exportación?",
		fr: "Bonjour, la demande pour ce patient est revenue refusée et il a appelé deux fois. Quelqu'un peut vérifier l'export ?",
		pt: "Oi pessoal, a guia deste paciente voltou negada e ele já ligou duas vezes. Alguém pode verificar a exportação?",
		vi: "Chào cả nhóm, yêu cầu của bệnh nhân này bị từ chối và họ đã gọi hai lần. Ai kiểm tra giúp bản xuất dữ liệu được không?",
	},
	ticketSubject: {
		de: "Abrechnung abgelehnt, Patient fragt nach",
		en: "Claim denied, patient asking why",
		es: "Reclamo denegado, el paciente pregunta por qué",
		fr: "Demande de remboursement refusée, le patient demande pourquoi",
		pt: "Guia negada, paciente quer saber o motivo",
		vi: "Yêu cầu bồi hoàn bị từ chối, bệnh nhân hỏi lý do",
	},
} satisfies Record<string, ByLang<string>>;

export { healthLabels, identifierLabels, phrases };
