Review the implementation and tests for two optional execution settings.

- `traceLabel`, when provided, is trimmed and reaches the provider. When absent, existing provider behavior remains unchanged.
- `timeoutMs`, when provided, reaches the provider. When absent, the provider keeps its existing default timeout.

The implementation may choose its internal module structure. Require only regression evidence needed to detect violations of these observable contracts.
