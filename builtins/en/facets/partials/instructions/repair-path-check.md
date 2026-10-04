{{include:instructions/contract-path-analysis}}

Before editing each repair target, reconstruct its responsible source and complete path graph. Even when a concern cites one location, repair every path required to establish the same invariant, retain connected established contracts, and do not expand changes into a different invariant or responsible source.

After editing, search again for reconstruction under another name, direct literals, obsolete helpers, unmigrated consumers, and one-sided updates, and remove any remaining violation.
