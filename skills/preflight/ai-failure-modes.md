# AI-code failure modes

The checklist the `ai-failure-modes` lens works through. Each item is a place
to look, not a finding: report one only with intended, observed and a concrete
failure case.

- Calls to APIs, flags, config keys or packages that do not exist or have a
  different signature; new dependencies that are unneeded or unverified.
- Tests that cannot fail: asserting on mocks, tautologies, mocking the thing
  under test, a snapshot updated to match the bug.
- Tests or assertions changed to make the suite pass rather than fixing code.
- Errors swallowed or replaced with fallbacks or defaults that hide failures.
- Hardcoded values or special cases that satisfy the test but not the general
  case; stubs and `TODO` placeholders presented as done.
- Reimplementing a helper the codebase already has; speculative abstraction,
  unused parameters, dead code.
- Comments and docstrings that describe code that is no longer there; PR
  description claims the diff does not support.
- Unrelated churn: reformatting, renames, lockfile changes outside scope.
- Leftovers: debug output, commented-out code, `.only`, secrets, local paths.
- Compatibility: public API, schema or migration, config or env changes
  without a migration path or docs.
