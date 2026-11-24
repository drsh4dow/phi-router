import { internalIdHealth, internalIds } from "./internal-ids.ts";
import type { Negative } from "./manifest.ts";
import { counts } from "./counts.ts";
import { fragmentSamples } from "./fragments.ts";
import { lookAlikes } from "./look-alikes.ts";
import { medicalTerms } from "./medical-terms.ts";
import { publicFigures } from "./public-figures.ts";
import { schemaOnly } from "./schema-only.ts";
import { staffContacts } from "./staff-contacts.ts";
import { syntheticListed } from "./synthetic.ts";

/** A negative stratum whose cases are text. Clean screenshots come from the image set instead. */
type TextNegative = Exclude<typeof Negative.Type, "clean-screenshot">;

const samplers = {
	count: counts,
	fragment: fragmentSamples,
	"internal-id": internalIds,
	"internal-id-health": internalIdHealth,
	"look-alike": lookAlikes,
	"medical-terms": medicalTerms,
	"public-figure": publicFigures,
	"schema-only": schemaOnly,
	"staff-contact": staffContacts,
	"synthetic-listed": syntheticListed,
} satisfies Record<TextNegative, typeof counts>;

export { samplers };

export type { TextNegative };
