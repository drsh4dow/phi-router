# The policy names the Safe Harbor identifiers

The judge's list of direct identifiers had 12 kinds. HIPAA's Safe Harbor method, [45 CFR 164.514(b)(2)(i)](https://www.law.cornell.edu/cfr/text/45/164.514), lists 18. The policy now also names the ones a claims or billing session holds and the list missed:

- (B) a city, county, ZIP code or geocode, as `geographic-detail`. The first three digits of a ZIP code alone do not count, which follows the rule's own exception.
- (E) a fax number, as `personal-fax`.
- (J) an account number, as `account-number`.
- (K) a certificate or license number other than a driver license, as `certificate-license`.
- (L) a vehicle identifier, as `vehicle-identifier`.
- (M) a device identifier or serial number, as `device-identifier`.
- (N) a URL, as `personal-url`.
- (O) an IP address, as `ip-address`.
- (P) a biometric identifier, as `biometric`.

Names (A), dates of birth (part of C), phone numbers (F), email addresses (G), SSNs, medical record numbers and health plan beneficiary numbers (D, H, I) and face photos (Q) were already on the list.

This is not a HIPAA certification. A de-identification under Safe Harbor also requires that the covered entity has no actual knowledge that the rest could identify the person. The judge reads one piece and cannot know that.

## Considered options

- Keep 12 kinds. Rejected: a claim in a session often holds a patient account number, a city and ZIP code, or a device serial number, and the judge cleared them.
- Add every kind as a rule (a pattern). Rejected: an account number, a city or a URL has no shape that tells a patient's apart from a business's. Only the judge can read who it belongs to.

## Consequences

- The policy version changes, so every stored verdict is judged again, and `tools/corpus/recordings.jsonl` is recorded again with `bun run eval:live -- --record`.
- The corpus deals every text kind, the new ones included, from one plan per seed, so adding a kind re-draws every case. The leak gate replays several draws, so the policy is held to fresh cases, not only to the ones it was tuned on. `biometric` has no case: no text draw is a realistic biometric.
- A URL in a file name is unrealistic, since its slashes make it a path, so the plan never deals it.
- The judge cleared a phone or fax number in a patient document's file name, and each prompt wording that caught it let an older case through. The rule `file-name-phone` catches it instead: a ten-digit North American phone number after a name segment and an underscore, then words and an extension.
- More pieces seal, so fewer requests stay on the open account. The pull request that added this reports the measured cost.
- Dates other than a date of birth (C) and other unique codes (R) stay out of this decision. The policy still says that clinical dates count only next to a direct identifier, and that a health fact tied only to an internal id is not one.
