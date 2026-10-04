Focus on reviewing **security**.

Explore in this order:

1. Identify the inputs, stored data, configuration, outputs, permissions, interpretation steps, and protected assets changed by the diff.
2. Identify who controls each input and which trust or authority boundary changes before and after the diff.
3. Trace real call paths from the lower-trust side to security-sensitive processing or assets.
4. Verify the path and concrete impact against the security criteria and reference material supplied by the task.
5. Stop when all changed definitions and references have been traced, inputs, stored data, configuration, outputs, and permission changes have been classified, every path where trust or authority changes has been checked, and no concrete evidence remains of an unchecked caller, consumer, or sink.

Do not decide that there is no boundary from filenames or diff lines alone. After satisfying the stopping conditions, record the result in the requested format.

{{include:instructions/security-knowledge-routing}}
