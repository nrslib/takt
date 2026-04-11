# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |

## Reporting a Vulnerability

If you discover a security vulnerability in TAKT, please report it responsibly.

### How to Report

1. **Do NOT** create a public GitHub issue for security vulnerabilities
2. Send an email to the maintainer with:
   - A description of the vulnerability
   - Steps to reproduce the issue
   - Potential impact assessment
   - Any suggested fixes (optional)

### What to Expect

- **Acknowledgment**: Within 7 days of your report
- **Status Update**: Within 14 days with an initial assessment
- **Resolution**: Depending on severity, typically within 30-90 days

### Disclosure Policy

- We follow responsible disclosure practices
- We will credit reporters in the security advisory (unless you prefer anonymity)
- Please allow us reasonable time to address the issue before public disclosure

## Security Considerations

### TAKT-Specific Security Notes

TAKT orchestrates AI agents that can execute code and access files. Users should be aware:

- **Trusted Directories**: TAKT requires explicit configuration of trusted directories in `~/.takt/config.yaml`
- **Agent Permissions**: Agents have access to tools like Bash, Edit, Write based on their configuration
- **Workflow Definitions**: Only use workflow files from trusted sources
- **Session Logs**: Session logs in `.takt/logs/` may contain sensitive information

### Best Practices

1. Review workflow YAML files before using them
2. Keep TAKT updated to the latest version
3. Limit trusted directories to necessary paths only
4. Be cautious when using custom agents from untrusted sources
5. Review agent prompts before execution

## Dependencies

TAKT uses the `@anthropic-ai/claude-agent-sdk` and other npm packages. We recommend:

- Running `npm audit` regularly
- Keeping dependencies updated
- Reviewing Dependabot alerts if enabled

## Contact

For security concerns, please reach out via the repository's security advisory feature or contact the maintainer directly.
