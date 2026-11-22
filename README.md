# makefun-mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/de0x1de/makefun-mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/de0x1de/makefun-mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one patch tool for every AI edit format: it applies unified diffs,
SEARCH/REPLACE blocks and V4A patches to a file tree, exactly as specified in
SPEC.md. The implementation is a single dependency-free TypeScript file
(main.ts, Node 22 standard library only) built directly from the spec: the
three-stage fuzzy matching of section 5, unified-diff application of
section 6, SEARCH/REPLACE of section 7, the V4A grammar of section 8, plus
the move/rename `R` lines of section 2. It passes all 100 public practice
checks (practice score 1000) and a set of additional hand-written edge cases
derived from the spec (rename-only and move-only patches, EOF insertion,
parse-error line numbers, `\ No newline` byte handling).

## Run it

```sh
node main.ts
```

(with MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR pointing at the case input and
output directories outside the harness container)

---

<sub>Entered on [make.fun](https://make.fun/?ref=tjxzfppk&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
