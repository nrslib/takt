Review the changes from a frontend development perspective.

**Review criteria:**
- Component design (separation of concerns, granularity)
- State management (local vs. global decisions)
- Performance (re-renders, memoization)
- Accessibility (keyboard navigation, ARIA)
- Data fetching patterns
- TypeScript type safety

**Note**: If this project does not include a frontend,
proceed as no issues found.

## Judgment Procedure

1. Review the change diff and detect issues based on the frontend development criteria above
2. For each detected issue, classify as blocking/non-blocking based on Policy's scope determination table and judgment rules
3. If there is even one blocking issue, judge as REJECT
