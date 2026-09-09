## Handoff to Reporting

The subsequent reporting phase cannot use tools and produces its report from explicitly supplied upstream artifacts and the current work result. In the final work result, retain every planned and newly discovered implementation obligation with its existing ID (if any), origin, meaning, implementation location, individual verification results, and direct evidence. Include these in the work result or summary of the existing output format, not only in a dedicated file.

- Preserve each upstream ID's meaning and mapping. Do not invent IDs for a plan without IDs.
- Distinguish missing implementation, failed verification, unexecuted checks, and environmental limitations; record observed facts and remaining work. Do not replace individual evidence with "all complete" or "tests passed".
- When decomposing into parts, require each part to return its assigned obligations and evidence, and aggregate them in the final summary. Do not assume automatic upstream-artifact inheritance or file rereading during reporting.
