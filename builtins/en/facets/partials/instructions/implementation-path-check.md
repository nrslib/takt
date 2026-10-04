{{include:instructions/contract-path-analysis}}

Before changing an observable contract, enumerate every related path. Implement every path required to establish the invariant, retain connected established contracts, and do not edit paths governed by a different invariant or responsible source.

After editing, search semantically for reconstruction under another name, direct literals, obsolete helpers, unmigrated consumers, and one-sided updates. Do not declare completion while a required path remains open.
