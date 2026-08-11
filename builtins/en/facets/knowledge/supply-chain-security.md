# Software supply-chain security knowledge

Review dependency and artifact trust boundaries:

- dependency declarations, lockfiles, registry and source selection, integrity metadata, and transitive updates;
- install, prepare, build, test, and publish scripts that execute code or alter artifacts;
- package provenance, release permissions, generated artifacts, signing, and promotion between environments;
- dependency confusion, typosquatting, unpinned inputs, and unreviewed changes in build tooling.

Tie each finding to the repository's dependency, build, or release path. Do not turn unrelated application behavior into a supply-chain finding.
