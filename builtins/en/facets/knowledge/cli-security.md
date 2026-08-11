# CLI security knowledge

Review command-line boundaries and local process behavior:

- argument parsing, option validation, path handling, shell interpolation, and command injection;
- subprocess environment, inherited descriptors, exit-status handling, and signal behavior;
- filesystem permissions, symlink and path traversal handling, temporary files, and local configuration;
- secret exposure through arguments, environment variables, logs, error output, and generated files.

Tie each finding to an executable command or local process boundary. Do not apply browser or dependency-release advice without a corresponding CLI path.
