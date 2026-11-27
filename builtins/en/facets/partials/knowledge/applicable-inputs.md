## Applicable Inputs and States

Evidence of applicability includes input formats covered by requirements, specifications, acceptance criteria, or pre-change user-facing contracts; values or formats actually produced by existing input sources; and records identifying inputs and failures in actual use. When a contract defines the input format itself, such as display names containing arbitrary characters, values of that format are applicable even without records. A set description such as all registered candidates alone does not establish applicability of arbitrary values within it.

Passing values through without validation, acceptance by a type, schema, argument, or parser, and deliberate construction using the OS or external tools alone do not establish actual use of a format. User-facing documentation, stored data, code, and pre-change tests can establish source formats. For formats commonly used at that source, such as names containing spaces or characters from various languages, showing that the format is used is sufficient.

For inputs created by someone other than the operator, such as imported files, another user's input, or integration responses, the source contract or documentation defines the applicable formats. For external input requiring defensive handling at a trust boundary, attack values need not be commonly used.

An earlier review, adjudication, verification, or plan raising an input, or tests added in response, alone do not establish applicability. Failures caused by values constructed for verification or planning differ from records identifying inputs and results of failures in actual use. Actual-use records collected later are evidence too. Correct input rejection is not a failure.

## Value Control and Trust Boundaries

The actors choosing values and the actors and authority running the reader determine the boundary, rather than storage location or the process that wrote the input. External content and other users' inputs remain external after the product stores, copies, or retrieves them.

State, settings, and records managed by the operator in their own environment and read only by processes run by that operator with the same permissions are inside the boundary. Merely assuming someone shares or distributes them, or overrides defaults that keep them unshared, does not make them external. Inputs the product is intended to read from shared sources, such as repository-shared configuration or imported files, are external. Writing processes, sharing defaults, synchronization or distribution, user-facing documentation, and import processes can establish this fact. Unconfirmed sharing differs from established absence of sharing.

A particular state of the operator's own environment variables, shell, or local settings alone does not establish applicability. When policy excludes already-compromised operator environments from protection, paths depending on that premise are excluded too. Paths involving external content but exploitable only with such special environment settings share that premise.

When a party able to change a value can directly produce the same result with the same permissions without changing it, the change alone does not establish a new threat.

## Concurrency and Volume

Applicability of a race requires evidence that operations on the same resource overlap in actual use. Product-controlled concurrent execution, simultaneous use specified by requirements or documentation, or records of overlapping operations that failed establish this. Merely assuming people happen to start operations at similar times does not establish overlap.

Applicable counts, sizes, and lengths follow limits established by requirements, existing contracts, or the input source, or quantities actually produced by that source. The ability to construct values exceeding technical buffer or argument-length limits alone is insufficient. For externally controlled input, quantities that can be sent within the accepted contract are also applicable.

Infrequent applicable inputs remain applicable. This includes quantities near contractual limits, large data, empty sets and format variations actually produced by the source, and overlapping operations between processes run concurrently by the product itself.
