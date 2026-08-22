# Architecture

Modules under `src/domain/` own business rules and serialized domain representations. They remain independent of operating-system I/O.

Modules under `src/adapters/` own filesystem and network effects and call domain operations through explicit inputs and results.
