import { Effect, String as Str } from "effect";
import { Findings, Verdicts } from "./index.ts";
import { assert, it } from "@effect/vitest";
import { judgedOne, pieceOf } from "./scripted-judge.ts";
import { Digest } from "effect/crypto";
import { identifierKind } from "#router/features/policy/index.ts";

/** Request 3 of corpus case h-0042, typos included, which the live judge cleared at 0.01. Synthetic values. */
const h0042 = `The conversation history before this point was compacted into the following summary:

<summary>
## Goal
The FHIR import job returns 422 for this bundle. Can you see why?

## Progress
### Done
- Bisected to the commit that changed the mapper.
### In Progress
- Comparing the captured input with the schema the importer expects.

## Critical Context
- The input in question:
{
  "resourceType": "Bnudle",
  "id": "811446e9-f8ca-473c-95e6-7cc212111388",
  "type": "collection",
  "enry": [
    {
      "fullUrl": "urn:uuid:209ab70b-161d-43f5-9134-b0c8ea97e946",
      "resuorce": {
        "resourceType": "Patient",
        "id": "209ab70b-161d-43f5-9134-b0c8ea97e946",
        "iddentifier": [
          {
            "type": {
              "coding": [
                {
                  "system": "http://terminology.hl7.org/CodeSytsem/v2-0203",
                  "code": "DL"
                }
              ]
            },
            "sstem": "urn:oid:2.16.840.1.113883.4.3.41",
            "value": "B3053196"
          }
        ],
        "gender": "male"
      }
    },
    {
      "fullUrl": "urn:uuid:44c036e0-4389-43f0-8eaf-b2c7f372f4c2",
      "reosurce": {
        "resoruceType": "Condition",
        "clinicalStatus": {
          "coding": [
            {
              "systtem": "http://temrinology.hl7.org/CodeSystem/cnodition-clinical",
              "code": "active"
            }
          ]
        },
        "code": {
          "coding": [
            {
              "system": "http://hl7.org/fhir/sid/icd-10-cm",
              "code": "C50.911",
              "dispay": "Malignant neolasm of right feemale breast"
            }
          ]
        },
        "sbuject": {
          "refeernce": "urn:uuid:209ab70b-161d-43f5-9134-b0c8ea97e946"
        }
      }
    },
    {
      "fullrl": "urn:uuid:1039dbee-12f1-4991-b097-131b100bd212",
      "reosurce": {
        "resourceType": "MedicationStatement",
        "status": "active",
        "medicationCodeableConcpt": {
          "text": "tammoxifen 20 mg daily"
        },
        "subject": {
          "rfeerence": "urn:uuid:209ab70b-161d-43f5-9134-b0c8ea97e946"
        }
      }
    }
  ]
}
</summary>`;

const sealed = [
	Verdicts.Sealed({ finding: Findings.Rule({ kind: identifierKind.patientName, rule: "fhir-coded-id" }) }),
];

const clearingScore = 0.01;

const values = ["B3053196", "K4817302", "V912-253-69-735-8"];

it.layer(Digest.layerWebCrypto)("a FHIR Patient whose only identifying field is a coded driver's licence", (test) => {
	test.effect.each(values)("with the value %s is sealed by a rule without asking the judge", (value) =>
		Effect.gen(function* codedLicence() {
			const piece = yield* pieceOf(Str.replaceAll("B3053196", value)(h0042));
			const { questions, verdicts } = yield* judgedOne({ piece, script: { score: () => clearingScore } });

			assert.deepStrictEqual({ questions, verdicts }, { questions: [], verdicts: sealed });
		}),
	);
});
