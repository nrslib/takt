# Object inspection and delivery

This change adds all functions in `src/readers.mjs`. The source is a remote object
whose length has no product or schema cap. `source.chunks()` is lazy: each pull
fetches one nonempty UTF-8 block of at most 1 KiB. `source.readText()` downloads and
materializes the complete object. Authentication and source selection are already
handled by the caller. Sources are fresh for each operation.

- `preview` returns the first 80 characters, or the entire object when shorter.
- `deliver` and `relay` each copy the complete object, in order, to an output sink.
  `sink.write(block)` resolves when that block has been accepted; callers can
  consume output incrementally. Partial output on transfer failure is allowed.
- `summarize` returns the total number of characters in the complete object.
- `readManifest` returns every entry from `manifest.readEntries()`. The manifest
  is a separate source with an enforced maximum of 16 entries of at most 64 bytes
  each. Entries retain their original order and fields.

No API redesign, persistence changes, or new numeric latency SLO is requested.
