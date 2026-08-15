# Local Process, Path, Terminal, and Configuration Security Knowledge

## Applicability

Apply when low-trust CLI arguments, environment variables, configuration, or repository content reach process execution, filesystem operations, terminal output, credentials, a sandbox, or local authority. Evaluate each source separately; local does not mean equally trusted.

## Process Execution

The executable, arguments, environment, working directory, loader, plugin, and search path are separate control points.

| Condition | Boundary and impact to verify |
|-----------|-------------------------------|
| A low-trust value enters a shell command string | Trace shell reinterpretation and the commands available under the launching process's authority |
| A value selects an executable, loader, plugin, environment entry, or search path | Identify who controls the value and whether execution crosses the declared authority or sandbox |
| A fixed executable receives an argument array without a shell | Confirm that the argument cannot itself select an interpreter, config, output target, or dangerous executable feature |

## Path and Filesystem Authority

Separate lexical path selection from authority over the resolved target. Relative normalization can establish lexical containment; existing symlinks and filesystem races require canonical or handle-based evidence only where the contract forbids escape. Identify who controls the path, which root is protected, the resolved read, write, or delete target, and the confidentiality or integrity impact.

## Terminal Interpretation

Repository labels, filenames, and command output may be less trusted than the terminal user. Distinguish visible text from control-sequence interpretation. Identify the actor controlling the bytes, the terminal sequence and semantics that are reachable, the resulting display, clipboard, input, or other effect, and who relies on the affected terminal.

## Repository and Local Configuration Trust

Repository configuration, user-global configuration, environment variables, runtime credentials, and explicit CLI choices can have different owners and trust levels. Determine which source wins, who controls it, and whether it can widen process, filesystem, terminal, credential, network, sandbox, tool, or local-permission boundaries. Documented selection among sources at the same trust level is not by itself an authority change.
