Review the following completed change. The full files are available at
`src/logger.ts` and `src/logger.test.ts` in the working directory.

Task intent: add a leveled `Logger` that writes to stderr, filters messages
below a configured minimum level, and exposes convenience methods for every
public `LogLevel`: `debug()`, `info()`, `warn()`, and `error()`. Each convenience
method must delegate to `log()`, and unit tests must cover all four methods.

The implementation under review is the current post-change state of those two
files. Treat all four convenience methods as an explicit acceptance criterion,
not as an optional symmetry or style improvement.
