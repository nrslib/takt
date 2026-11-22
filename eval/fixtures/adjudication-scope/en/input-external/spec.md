# Document Service
Read documents with the owner's permissions. The owner may read their own files using values from local configuration editable only by the owner.
External submitters must not be permitted to read files outside the public document directory. Preserve this restriction even when submitted values are processed with the owner's permissions.
Modifications to the owner's local state using the same permissions are outside the threat model.
In this deployment, external submissions are saved and the owner's worker reads the documents later. The submitter is a different principal from the processing process.
