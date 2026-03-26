Decompose the security audit task, assign files to each part, and execute in parallel.

**Important:** Refer to the plan report: {report:01-plan.md}

**What to do:**

1. Review the file list from the plan report and understand all files to be audited
2. Split files into 3 groups by module/layer
   - Distribute high-security-risk files (authentication, input handling, external communication, etc.) evenly across groups
   - Keep related files (within the same module) in the same group when possible
3. Assign exclusive file ownership to each part

**Each part's instruction MUST include:**
- **Assigned file list** (all file paths to review via Read)
- **Audit procedure:**
  1. **Read each assigned file in full using Read tool one by one** (do NOT abbreviate with Grep or partial reads)
  2. Review each file from a security perspective
  3. Report discovered issues with severity ratings
- **Strictly prohibited:**
  - Searching with Grep and only reviewing matching files → PROHIBITED. Read ALL files
  - Reading only part of a file → PROHIBITED. Read the entire file
  - Skipping a file because it "looks fine" → PROHIBITED. Review every file
- **Completion criteria:** All assigned files have been Read in full, and audit results are reported for each file

**Constraints:**
- Each part is read-only. Do not modify code
- Do not audit files outside your assignment (to prevent overlap)
