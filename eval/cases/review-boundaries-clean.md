Review the document import change in the working directory.

The complete change consists of:

- `README.md`
- `src/types.ts`
- `src/import-document.ts`
- `src/cli-import.ts`
- `src/system-enqueue.ts`
- `src/interactive-import.ts`

Task intent:

- Import a document body and its linked previews.
- The body is the primary result; previews are optional auxiliary artifacts.
- A failed preview must be reported without discarding the body.
- CLI, system enqueue, and interactive entry points must preserve successful previews.
- Temporary previews must be released after their last consumer on success and failure paths.

Review the implementation against that contract. Report only defects supported
by the files in the working directory.
