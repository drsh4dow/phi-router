import type { Array } from "effect";
import type { ByLang } from "./people.ts";

/** The health half of a PHI record: an ICD-10-CM diagnosis and the drug that treats it. */
export interface Diagnosis {
	readonly code: string;
	readonly text: ByLang<string>;
	readonly medication: ByLang<string>;
}

export const diagnoses: Array.NonEmptyReadonlyArray<Diagnosis> = [
	{
		code: "E11.9",
		medication: {
			de: "Metformin 500 mg zweimal täglich",
			en: "metformin 500 mg twice daily",
			es: "metformina 500 mg dos veces al día",
			fr: "metformine 500 mg deux fois par jour",
			pt: "metformina 500 mg duas vezes ao dia",
			vi: "metformin 500 mg ngày hai lần",
		},
		text: {
			de: "Diabetes mellitus Typ 2 ohne Komplikationen",
			en: "Type 2 diabetes mellitus without complications",
			es: "Diabetes mellitus tipo 2 sin complicaciones",
			fr: "Diabète de type 2 sans complication",
			pt: "Diabetes mellitus tipo 2 sem complicações",
			vi: "Đái tháo đường type 2 không biến chứng",
		},
	},
	{
		code: "I10",
		medication: {
			de: "Lisinopril 10 mg täglich",
			en: "lisinopril 10 mg daily",
			es: "lisinopril 10 mg al día",
			fr: "lisinopril 10 mg par jour",
			pt: "lisinopril 10 mg ao dia",
			vi: "lisinopril 10 mg mỗi ngày",
		},
		text: {
			de: "Essentielle Hypertonie",
			en: "Essential hypertension",
			es: "Hipertensión esencial",
			fr: "Hypertension essentielle",
			pt: "Hipertensão essencial",
			vi: "Tăng huyết áp vô căn",
		},
	},
	{
		code: "F32.1",
		medication: {
			de: "Sertralin 50 mg täglich",
			en: "sertraline 50 mg daily",
			es: "sertralina 50 mg al día",
			fr: "sertraline 50 mg par jour",
			pt: "sertralina 50 mg ao dia",
			vi: "sertraline 50 mg mỗi ngày",
		},
		text: {
			de: "Mittelgradige depressive Episode",
			en: "Major depressive disorder, single episode, moderate",
			es: "Trastorno depresivo mayor, episodio único, moderado",
			fr: "Épisode dépressif majeur, modéré",
			pt: "Transtorno depressivo maior, episódio único, moderado",
			vi: "Rối loạn trầm cảm chủ yếu, giai đoạn đơn, mức độ vừa",
		},
	},
	{
		code: "C50.911",
		medication: {
			de: "Tamoxifen 20 mg täglich",
			en: "tamoxifen 20 mg daily",
			es: "tamoxifeno 20 mg al día",
			fr: "tamoxifène 20 mg par jour",
			pt: "tamoxifeno 20 mg ao dia",
			vi: "tamoxifen 20 mg mỗi ngày",
		},
		text: {
			de: "Bösartige Neubildung der rechten Brustdrüse",
			en: "Malignant neoplasm of right female breast",
			es: "Neoplasia maligna de mama derecha",
			fr: "Tumeur maligne du sein droit",
			pt: "Neoplasia maligna da mama direita",
			vi: "Ung thư vú phải",
		},
	},
	{
		code: "B20",
		medication: {
			de: "Bictegravir/Emtricitabin/Tenofoviralafenamid 1 Tablette täglich",
			en: "bictegravir/emtricitabine/tenofovir alafenamide 1 tablet daily",
			es: "bictegravir/emtricitabina/tenofovir alafenamida 1 comprimido al día",
			fr: "bictégravir/emtricitabine/ténofovir alafénamide 1 comprimé par jour",
			pt: "bictegravir/entricitabina/tenofovir alafenamida 1 comprimido ao dia",
			vi: "bictegravir/emtricitabine/tenofovir alafenamide 1 viên mỗi ngày",
		},
		text: {
			de: "HIV-Krankheit",
			en: "Human immunodeficiency virus [HIV] disease",
			es: "Enfermedad por virus de la inmunodeficiencia humana [VIH]",
			fr: "Maladie due au virus de l'immunodéficience humaine [VIH]",
			pt: "Doença pelo vírus da imunodeficiência humana [HIV]",
			vi: "Bệnh do virus gây suy giảm miễn dịch ở người [HIV]",
		},
	},
	{
		code: "N18.4",
		medication: {
			de: "Furosemid 40 mg täglich",
			en: "furosemide 40 mg daily",
			es: "furosemida 40 mg al día",
			fr: "furosémide 40 mg par jour",
			pt: "furosemida 40 mg ao dia",
			vi: "furosemide 40 mg mỗi ngày",
		},
		text: {
			de: "Chronische Nierenkrankheit, Stadium 4",
			en: "Chronic kidney disease, stage 4",
			es: "Enfermedad renal crónica, estadio 4",
			fr: "Maladie rénale chronique, stade 4",
			pt: "Doença renal crônica, estágio 4",
			vi: "Bệnh thận mạn giai đoạn 4",
		},
	},
	{
		code: "F10.20",
		medication: {
			de: "Naltrexon 50 mg täglich",
			en: "naltrexone 50 mg daily",
			es: "naltrexona 50 mg al día",
			fr: "naltrexone 50 mg par jour",
			pt: "naltrexona 50 mg ao dia",
			vi: "naltrexone 50 mg mỗi ngày",
		},
		text: {
			de: "Alkoholabhängigkeit, unkompliziert",
			en: "Alcohol dependence, uncomplicated",
			es: "Dependencia del alcohol, sin complicaciones",
			fr: "Dépendance à l'alcool, sans complication",
			pt: "Dependência de álcool, sem complicações",
			vi: "Nghiện rượu, không biến chứng",
		},
	},
	{
		code: "J45.40",
		medication: {
			de: "Budesonid/Formoterol 160/4,5 µg zwei Hübe zweimal täglich",
			en: "budesonide/formoterol 160/4.5 mcg two puffs twice daily",
			es: "budesonida/formoterol 160/4,5 mcg dos inhalaciones dos veces al día",
			fr: "budésonide/formotérol 160/4,5 µg deux bouffées deux fois par jour",
			pt: "budesonida/formoterol 160/4,5 mcg duas inalações duas vezes ao dia",
			vi: "budesonide/formoterol 160/4,5 mcg hai nhát xịt ngày hai lần",
		},
		text: {
			de: "Mittelgradiges persistierendes Asthma",
			en: "Moderate persistent asthma, uncomplicated",
			es: "Asma persistente moderada, sin complicaciones",
			fr: "Asthme persistant modéré",
			pt: "Asma persistente moderada, sem complicações",
			vi: "Hen phế quản dai dẳng mức độ vừa",
		},
	},
	{
		code: "G40.909",
		medication: {
			de: "Levetiracetam 500 mg zweimal täglich",
			en: "levetiracetam 500 mg twice daily",
			es: "levetiracetam 500 mg dos veces al día",
			fr: "lévétiracétam 500 mg deux fois par jour",
			pt: "levetiracetam 500 mg duas vezes ao dia",
			vi: "levetiracetam 500 mg ngày hai lần",
		},
		text: {
			de: "Epilepsie, nicht näher bezeichnet",
			en: "Epilepsy, unspecified, not intractable",
			es: "Epilepsia no especificada, no refractaria",
			fr: "Épilepsie, sans précision",
			pt: "Epilepsia não especificada, não refratária",
			vi: "Động kinh, không đặc hiệu",
		},
	},
	{
		code: "O24.410",
		medication: {
			de: "Pränatales Vitaminpräparat 1 Tablette täglich",
			en: "prenatal vitamin 1 tablet daily",
			es: "vitamina prenatal 1 comprimido al día",
			fr: "vitamine prénatale 1 comprimé par jour",
			pt: "vitamina pré-natal 1 comprimido ao dia",
			vi: "vitamin tiền sản 1 viên mỗi ngày",
		},
		text: {
			de: "Gestationsdiabetes, diätetisch eingestellt",
			en: "Gestational diabetes mellitus in pregnancy, diet controlled",
			es: "Diabetes gestacional controlada con dieta",
			fr: "Diabète gestationnel contrôlé par le régime",
			pt: "Diabetes gestacional controlada com dieta",
			vi: "Đái tháo đường thai kỳ, kiểm soát bằng chế độ ăn",
		},
	},
];
