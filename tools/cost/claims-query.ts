import { Array, Option, String as Str, pipe } from "effect";
import type { Asked, Said } from "#router/client/mock-upstreams/index.ts";
import { calling, handleIn, resultOf, said } from "#tools/wire/answer-checks.ts";
import { isSubagent } from "#tools/wire/phi-checks.ts";

const memberPrefix = "ZQX-";

const failedClaim = "CLM-20931";

const failedMember = "m-0412";

const repeated = `${failedClaim}\t${failedMember}\tQuillon Vellacourt\tZQX-0400-0000\t2026-10-01\t120.00\tDENIED\tCO-16`;

const fixedJoin = "JOIN latest_coverage lc ON lc.member_id = c.member_id AND lc.rn = 1";

const brokenJoin = "JOIN latest_coverage lc ON lc.member_id = c.member_id";

const rows = `claim_id\tmember_id\tpatient_name\tmember_number\tservice_date\tbilled\tstatus\tdenial_code
CLM-20931\tm-0412\tQuillon Vellacourt\tZQX-0400-0000\t2026-10-01\t120.00\tDENIED\tCO-16
CLM-33164\tm-2036\tCorwyth Vellacourt\tZQX-0428-1732\t2026-10-01\t1268.00\tDENIED\tCO-17
CLM-30113\tm-1037\tMarisande Ashgrove\tZQX-0401-7919\t2026-10-02\t161.00\tDENIED\tCO-17
CLM-33277\tm-2073\tElspara Ashgrove\tZQX-0429-9651\t2026-10-02\t1309.00\tDENIED\tCO-18
CLM-30226\tm-1074\tTobrecht Pennywhistle\tZQX-0402-5838\t2026-10-03\t202.00\tDENIED\tCO-18
CLM-30339\tm-1111\tIlvana Morrowind\tZQX-0403-3757\t2026-10-04\t243.00\tDENIED\tCO-19
CLM-30452\tm-1148\tCorwyth Fairbrook\tZQX-0404-1676\t2026-10-05\t284.00\tDENIED\tCO-20
CLM-30565\tm-1185\tElspara Thistledown\tZQX-0405-9595\t2026-10-06\t325.00\tDENIED\tCO-21
CLM-30678\tm-1222\tDunmore Kestrelmoor\tZQX-0406-7514\t2026-10-07\t366.00\tDENIED\tCO-22
CLM-30791\tm-1259\tSabeline Vellacourt\tZQX-0407-5433\t2026-10-08\t407.00\tDENIED\tCO-23
CLM-30904\tm-1296\tQuillon Ashgrove\tZQX-0408-3352\t2026-10-09\t448.00\tDENIED\tCO-24
CLM-31017\tm-1333\tMarisande Pennywhistle\tZQX-0409-1271\t2026-10-10\t489.00\tDENIED\tCO-16
CLM-31130\tm-1370\tTobrecht Morrowind\tZQX-0410-9190\t2026-10-11\t530.00\tDENIED\tCO-17
CLM-31243\tm-1407\tIlvana Fairbrook\tZQX-0411-7109\t2026-10-12\t571.00\tDENIED\tCO-18
CLM-31356\tm-1444\tCorwyth Thistledown\tZQX-0412-5028\t2026-10-13\t612.00\tDENIED\tCO-19
CLM-31469\tm-1481\tElspara Kestrelmoor\tZQX-0413-2947\t2026-10-14\t653.00\tDENIED\tCO-20
CLM-31582\tm-1518\tDunmore Vellacourt\tZQX-0414-0866\t2026-10-15\t694.00\tDENIED\tCO-21
CLM-31695\tm-1555\tSabeline Ashgrove\tZQX-0415-8785\t2026-10-16\t735.00\tDENIED\tCO-22
CLM-31808\tm-1592\tQuillon Pennywhistle\tZQX-0416-6704\t2026-10-17\t776.00\tDENIED\tCO-23
CLM-31921\tm-1629\tMarisande Morrowind\tZQX-0417-4623\t2026-10-18\t817.00\tDENIED\tCO-24
CLM-32034\tm-1666\tTobrecht Fairbrook\tZQX-0418-2542\t2026-10-19\t858.00\tDENIED\tCO-16
CLM-32147\tm-1703\tIlvana Thistledown\tZQX-0419-0461\t2026-10-20\t899.00\tDENIED\tCO-17
CLM-32260\tm-1740\tCorwyth Kestrelmoor\tZQX-0420-8380\t2026-10-21\t940.00\tDENIED\tCO-18
CLM-32373\tm-1777\tElspara Vellacourt\tZQX-0421-6299\t2026-10-22\t981.00\tDENIED\tCO-19
CLM-32486\tm-1814\tDunmore Ashgrove\tZQX-0422-4218\t2026-10-23\t1022.00\tDENIED\tCO-20
CLM-32599\tm-1851\tSabeline Pennywhistle\tZQX-0423-2137\t2026-10-24\t1063.00\tDENIED\tCO-21
CLM-32712\tm-1888\tQuillon Morrowind\tZQX-0424-0056\t2026-10-25\t1104.00\tDENIED\tCO-22
CLM-32825\tm-1925\tMarisande Fairbrook\tZQX-0425-7975\t2026-10-26\t1145.00\tDENIED\tCO-23
CLM-32938\tm-1962\tTobrecht Thistledown\tZQX-0426-5894\t2026-10-27\t1186.00\tDENIED\tCO-24
CLM-33051\tm-1999\tIlvana Kestrelmoor\tZQX-0427-3813\t2026-10-28\t1227.00\tDENIED\tCO-16
`;

const query = `-- Nightly report: claims the payer denied in the last 30 days, one row per claim.
-- Feeds claims/loader.py, which posts the rows to the denials dashboard.
WITH latest_coverage AS (
    SELECT
        cv.member_id,
        cv.plan_code,
        cv.effective_from,
        cv.effective_to,
        ROW_NUMBER() OVER (
            PARTITION BY cv.member_id
            ORDER BY cv.effective_from DESC, cv.updated_at DESC
        ) AS rn
    FROM coverage cv
    WHERE cv.effective_from <= CURRENT_DATE
),
denied AS (
    SELECT
        cl.claim_id,
        cl.member_id,
        cl.service_date,
        cl.billed_amount,
        cl.status,
        cl.denial_code
    FROM claims cl
    WHERE cl.status = 'DENIED'
      AND cl.adjudicated_at >= CURRENT_DATE - INTERVAL '30 days'
)
SELECT
    c.claim_id,
    c.member_id,
    m.full_name AS patient_name,
    m.member_number,
    c.service_date,
    c.billed_amount AS billed,
    c.status,
    c.denial_code
FROM denied c
JOIN members m ON m.member_id = c.member_id
${brokenJoin}
LEFT JOIN plans p ON p.plan_code = lc.plan_code
ORDER BY c.service_date, c.claim_id;
`;

const loader = `"""Load the nightly denied-claims report into the denials dashboard.

The report must hold exactly one row per claim: the dashboard keys rows by
claim_id and rejects a batch that repeats one.
"""

from __future__ import annotations

import csv
import io
import logging
import os
import subprocess
from dataclasses import dataclass
from decimal import Decimal

import requests

LOG = logging.getLogger("claims.loader")
DASHBOARD = os.environ.get("DENIALS_DASHBOARD_URL", "http://localhost:8040/api/denials")
QUERY = os.path.join(os.path.dirname(__file__), "failed_claims.sql")


@dataclass(frozen=True)
class Denial:
    claim_id: str
    member_id: str
    service_date: str
    billed: Decimal
    denial_code: str


class DuplicateClaim(Exception):
    pass


def run_query() -> list[dict[str, str]]:
    out = subprocess.run(
        ["psql", "--no-psqlrc", "--tuples-only", "--field-separator=\t", "-f", QUERY],
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    return list(csv.DictReader(io.StringIO(out), delimiter="\t"))


def to_denials(rows: list[dict[str, str]]) -> list[Denial]:
    seen: set[str] = set()
    denials = []
    for row in rows:
        if row["claim_id"] in seen:
            raise DuplicateClaim(row["claim_id"])
        seen.add(row["claim_id"])
        denials.append(
            Denial(
                claim_id=row["claim_id"],
                member_id=row["member_id"],
                service_date=row["service_date"],
                billed=Decimal(row["billed"]),
                denial_code=row["denial_code"],
            )
        )
    return denials


def post(denials: list[Denial]) -> None:
    payload = [
        {
            "claim_id": d.claim_id,
            "member_id": d.member_id,
            "service_date": d.service_date,
            "billed": str(d.billed),
            "denial_code": d.denial_code,
        }
        for d in denials
    ]
    response = requests.post(DASHBOARD, json=payload, timeout=30)
    response.raise_for_status()
    LOG.info("posted %d denials", len(payload))


def main() -> None:
    logging.basicConfig(level=logging.INFO)
    post(to_denials(run_query()))


if __name__ == "__main__":
    main()
`;

const readme = `# claims-reports

Nightly reports over the claims warehouse.

## failed_claims

\`claims/failed_claims.sql\` lists the claims the payer denied in the last 30
days, one row per claim. \`claims/loader.py\` posts them to the denials
dashboard, which rejects a batch that repeats a claim_id.

Run the query against the warehouse replica:

    ./run-claims.sh

It prints the rows as tab-separated values with a header line. The rows hold
member names and member numbers, so never paste them into a ticket; refer to a
member by member_id.

## Tables

| table    | key          | notes                                              |
| -------- | ------------ | -------------------------------------------------- |
| claims   | claim_id     | one row per adjudicated claim                      |
| members  | member_id    | full_name and member_number are PHI                |
| coverage | (member_id, effective_from) | a member can hold several coverage rows |
| plans    | plan_code    | plan names and tiers                               |

## On call

The loader runs at 02:10 UTC. When it fails with DuplicateClaim, the report
query returned a claim twice: check the joins first.
`;

const runner = `#!/bin/sh
if grep -q 'AND lc.rn = 1' claims/failed_claims.sql; then
	cat claims/.out/fixed.tsv
else
	cat claims/.out/broken.tsv
fi
`;

const prompt =
	"The nightly loader fails with DuplicateClaim. Look at claims/failed_claims.sql and claims/loader.py, run ./run-claims.sh, find which claim repeats and why, fix the query, rerun it and give me a short report.";

const report = `Fixed claims/failed_claims.sql. Claim ${failedClaim} (member_id ${failedMember}) came back twice because the member holds two coverage rows and the join to latest_coverage kept both. The join now keeps only the latest coverage row (lc.rn = 1), and the rerun returns one row per claim.`;

const subagentAnswer = `${failedClaim} repeats: member_id ${failedMember} has two coverage rows, and the join to latest_coverage returns the claim once for each.`;

interface Step {
	readonly id: string;
	readonly name: string;
	readonly reply: (body: string) => Said;
	readonly skipped: (body: string) => boolean;
}

interface ClaimsQuery {
	readonly files: Readonly<Record<string, string>>;
	readonly holdsPhi: (piece: string) => boolean;
	readonly prompt: string;
	readonly report: string;
	readonly script: (asked: Asked) => Said;
	readonly stepOf: (body: string) => string;
}

const next = 1;

const neverSkipped = (): boolean => false;

const handleOf = (body: string): string => Option.getOrElse(handleIn(body), () => "the sealed part");

const seesRows = Str.includes(memberPrefix);

const reading = (id: string, file: string): Step => ({
	id,
	name: `read ${file}`,
	reply: () => calling({ id, input: `{"file_path":"${file}"}`, name: "Read" }),
	skipped: neverSkipped,
});

const running = (id: string, name: string): Step => ({
	id,
	name,
	reply: () =>
		calling({ id, input: `{"command":"./run-claims.sh","description":"Run the failed claims query"}`, name: "Bash" }),
	skipped: neverSkipped,
});

const delegating: Step = {
	id: "toolu_cost_agent",
	name: "start the pinned subagent",
	reply: (body) =>
		calling({
			id: "toolu_cost_agent",
			input: `{"description":"Find the repeated claim","prompt":"The query output in ${handleOf(body)} repeats one claim_id. Return that claim_id, its internal member_id and why it repeats. No names or member numbers.","run_in_background":false,"subagent_type":"phi-router:phi-sealed"}`,
			name: "Agent",
		}),
	skipped: seesRows,
};

const editing = (file: string): Step => ({
	id: "toolu_cost_edit",
	name: "edit the query",
	reply: () =>
		calling({
			id: "toolu_cost_edit",
			input: `{"file_path":"${file}","new_string":"${fixedJoin}","old_string":"${brokenJoin}"}`,
			name: "Edit",
		}),
	skipped: neverSkipped,
});

const reporting: Step = {
	id: "toolu_cost_none",
	name: "write the report",
	reply: () => said([report]),
	skipped: neverSkipped,
};

const stepsIn = (work: string): readonly Step[] => [
	reading("toolu_cost_readme", `${work}/README.md`),
	reading("toolu_cost_query", `${work}/claims/failed_claims.sql`),
	reading("toolu_cost_loader", `${work}/claims/loader.py`),
	running("toolu_cost_run", "run the query"),
	delegating,
	editing(`${work}/claims/failed_claims.sql`),
	running("toolu_cost_rerun", "rerun the query"),
];

const nextStep = (steps: readonly Step[], body: string): Step =>
	pipe(
		steps,
		Array.findLastIndex(({ id }) => Str.includes(resultOf(id))(body)),
		Option.match({ onNone: () => steps, onSome: (index) => Array.drop(steps, index + next) }),
		Array.findFirst((step) => !step.skipped(body)),
		Option.getOrElse(() => reporting),
	);

const subagentStep = "pinned subagent answers";

const claimsQuery = (work: string): ClaimsQuery => {
	const steps = stepsIn(work);

	return {
		files: {
			"README.md": readme,
			"claims/.out/broken.tsv": Str.replace(repeated, `${repeated}\n${repeated}`)(rows),
			"claims/.out/fixed.tsv": rows,
			"claims/failed_claims.sql": query,
			"claims/loader.py": loader,
			"run-claims.sh": runner,
		},
		holdsPhi: seesRows,
		prompt,
		report,
		script: ({ body }) => {
			if (isSubagent({ body })) {
				return said([subagentAnswer]);
			}

			return nextStep(steps, body).reply(body);
		},
		stepOf: (body) => {
			if (isSubagent({ body })) {
				return subagentStep;
			}

			return nextStep(steps, body).name;
		},
	};
};

export { claimsQuery, subagentStep };
