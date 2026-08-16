Normalize the `channel` option once at the public boundary. The accepted values are `local` and `cloud`, case-insensitively and with surrounding whitespace ignored. Every execution path must use and retain the normalized value. Invalid string values must fail fast. Do not add legacy aliases.

The same `normalizeChannel` responsibility also defines a separate error contract: every unsupported input, including non-string values, must fail with `Error("Unsupported channel")` rather than an incidental `TypeError`. Adjudicate every submitted finding against the existing family record without treating a shared responsible source as sufficient for merger.

After the standard review-resolution report, output exactly one final line in this form:

`JUDGEMENT: candidate=ARCH-NEW-channel-type-error-L2; decision=<merge|separate>; target_family=<family ID>`
