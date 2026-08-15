Normalize the `channel` option once at the public boundary. The accepted values are `local` and `cloud`, case-insensitively and with surrounding whitespace ignored. Every execution path must use and retain the normalized value. Invalid string values must fail fast. Do not add legacy aliases.

Adjudicate the submitted findings against the existing family record. After the standard review-resolution report, output exactly one final line in this form:

`JUDGEMENT: candidate=ARCH-NEW-channel-normalization-L2; decision=<merge|separate>; target_family=<family ID>`
