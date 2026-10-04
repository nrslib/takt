{{include:instructions/base-plan}}

## Additional Steps for Maintenance Work

1. Enumerate contracts outside the change scope that existing users, tests, or operations depend on, with a Contract ID and supporting evidence.
2. Classify every candidate change as `required` when directly necessary for the request, `related` when necessary to connect, verify, or keep a required change consistent, or `unnecessary` when not needed to satisfy the request. Proximity, being in the same file, or general style is not sufficient justification.
3. Exclude every `unnecessary` candidate from implementation and identify it in the Coder guidance as work that must not be implemented.
4. Plan contracts being replaced separately from existing contracts being preserved.
   - For a replaced contract, record its Contract ID, replacement reason, and impact scope, then track current-consumer migration separately from migration or removal of every support target explicitly required by the request.
   - For a preserved contract, record its Contract ID, evidence of the current contract, preservation mechanism, and verification method.
