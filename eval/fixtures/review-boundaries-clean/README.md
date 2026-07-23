# Document import contract

The document body is the primary result. Linked previews are optional auxiliary
artifacts: one failed preview must be reported without discarding the body.

Every entry point that imports a document must preserve successfully downloaded
previews. Temporary previews must be released after their last consumer on
success, early return, and failure paths.
