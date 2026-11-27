# A patient date or claim number counts on its own

HIPAA's Safe Harbor method, [45 CFR 164.514(b)(2)(i)](https://www.law.cornell.edu/cfr/text/45/164.514), removes (C) every element of a date, other than the year, directly related to an individual, and ages over 89, and (R) any other unique identifying number, characteristic or code. The policy said that clinical dates other than a date of birth count only next to a direct identifier of the same person, and named no claim number.

The policy now counts a date of service, admission, discharge or death with more than its year, as `patient-date`, and a claim, encounter or prior authorization number, as `claim-number`, on their own. That a claim or encounter number falls under (R) is our reading, not the rule's text: a payer or provider assigns it to one patient.

The policy still says that an internal id is not a direct identifier, and that a health fact tied only to an internal id is not one. 45 CFR 164.514(c) lets a covered entity keep a code of its own for re-identification, and the pinned subagent's way out is to refer to each person by an internal id.

This is not a HIPAA certification.

## Considered options

- Keep the old default. Rejected for a claims or billing user: a date of service next to a diagnosis and a claim number reaches the open account.
- Also count internal ids. Rejected: it removes the pinned subagent's way out and seals nearly every piece of a session that reads a database.

## Consequences

- Clean cases sealed anyway rose from 42 to 113 of 352 on the default corpus: every fragment and clean screenshot case, and 19 of 32 internal-id cases, now seal. Fewer requests stay on the open account.
- This decision lives in its own commit and ADR, so the maintainer can drop it and keep [ADR 0017](0017-the-policy-names-the-safe-harbor-identifiers.md).
