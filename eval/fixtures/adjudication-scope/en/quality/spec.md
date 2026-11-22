# Delivery Service
This change adds preview alongside the existing publish operation. Both normalize the same delivery input by the same rules.
Trim the recipient and lowercase it; trim the subject; truncate retries to an integer with a lower bound of 0.
Applicable design standard: normalization rules with the same contract and reason for change have one owner. Preserve both correct results and a structure in which rule changes update the shared contract consistently.
The existing src/normalization.mjs owns delivery normalization. This change added preview in src/entry.mjs.
Audit headings have a separate display contract managed independently by the audit team. Future changes to delivery subjects do not require audit rule changes.
Preserve the public interface and successful return formats.
