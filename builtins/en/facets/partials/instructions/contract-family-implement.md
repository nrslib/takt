**Contract family role: `implement`**

{{include:instructions/contract-family-core}}

When changing an observable contract, enumerate and classify its graph before editing. Implement every `participates` path, preserve every `preserved` path, and do not edit `outside` paths.

After editing, search semantically for reconstruction under another name, direct literals, obsolete helpers, unmigrated consumers, and one-sided updates. Do not declare completion while a `participates` path remains open.
