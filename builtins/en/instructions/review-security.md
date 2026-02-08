Review the changes from a security perspective. Check for the following vulnerabilities:
- Injection attacks (SQL, command, XSS)
- Authentication and authorization flaws
- Data exposure risks
- Cryptographic weaknesses

## Judgment Procedure

1. Review the change diff and detect issues based on the security criteria above
2. For each detected issue, classify as blocking/non-blocking based on Policy's scope determination table and judgment rules
3. If there is even one blocking issue, judge as REJECT
