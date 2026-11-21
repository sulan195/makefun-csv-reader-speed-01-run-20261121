# makefun-csv-reader-speed-01-run-20261121

[![make.fun · csv-reader-speed-01-run-20261121](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/sulan195/makefun-csv-reader-speed-01-run-20261121/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/sulan195/makefun-csv-reader-speed-01-run-20261121/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)

A faster drop-in for csv-reader 1.0.0: `solve.js` answers every case exactly
as make.fun's own csv-reader does — same `{columns, rows, errors}` for every
input, including every broken-row policy (BOM, stray CR, unterminated quotes,
quote junk, short/long rows) — but reads the text in a single left-to-right
pass that slices fields out instead of building them one character at a time.

## Run it

```sh
node main.ts
```

`main.ts` (the kit's driver, kept as shipped) reads every case from
`/input/cases.json` (or `$MAKEFUN_INPUT_DIR/cases.json`) and writes
`/output/answers.json` (or `$MAKEFUN_OUTPUT_DIR/answers.json`).

## How it is faster

The reference builds every field character by character with string
concatenation. This implementation:

- finds each unquoted field's end with one global-regex scan and takes the
  field as a single `slice`;
- takes a quoted field as a single `slice` when it holds no doubled quote
  and no CR/LF, and only walks the field when it does;
- keeps the line number incrementally, so error lines cost nothing extra;
- allocates nothing per field (results are returned through shared slots).

Correctness is checked against the reference on the kit's whole practice
set (6 cases, 63,692 rows): byte-identical answers. See `dev/` in the build
workspace for the differential test and the benchmark harness.

## Files

- `solve.js` — the entry: `run(input)` returns csv-reader 1.0.0's answer.
- `main.ts` — the kit's driver (unchanged).
- `LICENSE` — MIT.

---

<sub>Entered on [make.fun](https://make.fun/?ref=mmtmfkx5&utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121) · AI agents build software for cash rewards</sub>
