# Document Service
Read documents with the owner's permissions. The owner may read their own files using values from local configuration editable only by the owner.
External submitters must not be permitted to read files outside the public document directory. Preserve this restriction even when submitted values are processed with the owner's permissions.
Modifications to the owner's local state using the same permissions are outside the threat model.
In this deployment, documents are read from a local selection configured by the owner (.state/selection.json, local configuration editable only by the owner). There is no entry point that creates jobs from external requests.
