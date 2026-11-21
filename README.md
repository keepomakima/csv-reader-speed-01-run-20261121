# Fast CSV Reader — csv-reader-speed-01-run-20261121

[![make.fun · csv-reader-speed-01-run-20261121](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/keepomakima/csv-reader-speed-01-run-20261121/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/keepomakima/csv-reader-speed-01-run-20261121/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)

A fast, dependency-free drop-in replacement for csv-reader 1.0.0, built for
the make.fun bounty `csv-reader-speed-01-run-20261121` ("Read broken CSV
files faster, 21 November 2026"). `solve.js` exports `run(input)` returning
`{ columns, rows, errors }` with **byte-identical output** to the reference
on every input — including its broken-row semantics — at a fraction of the
CPU time.

## Speed

On the kit's practice set (6 cases, ~10.2 MB total), trimmed mean of 9
fresh-process runs (1 warm-up, `--no-incremental-marking`, same flags the
harness uses):

| program | ms / set |
| --- | --- |
| csv-reader 1.0.0 (house baseline) | 694 |
| this entry | 196 |

**~3.5× faster than the house baseline**, verified against the kit's
`practice/reference/expected.json` (all 6 cases exact) plus 79 hand-written
edge cases and 6,000 randomized fuzz cases, all matching the reference.

## How it is fast

csv-reader 1.0.0 walks the input one character at a time, building every
field with `value += c` and a helper call per character. This parser never
touches a character twice:

- A whole line with no quote and no stray CR is split in C++ (`split(',')`).
- A line whose quoted fields all close on the same line is split the same
  way: the unquoted runs between quoted fields go through `split(',')`, and
  each quoted field is one `slice()` between two `indexOf` jumps (doubled
  quotes folded in the same loop).
- Anything else — a quoted field spanning lines, an unterminated quote, junk
  after a closing quote, a stray CR, a quote inside an unquoted field —
  falls back to a field-by-field scanner that follows the reference step
  by step.
- An unquoted field is one `slice()` per field (built from slices around
  any stray CR), never a per-character concatenation.
- A stray CR inside an unquoted field is dropped (`stray_cr`) and the field
  is built from slices around it.
- Lines inside a quoted field are only counted once the quote is confirmed
  closed; on `unterminated_quote` they are discarded and the opening quote
  is re-read as a literal, exactly like the reference.

## Semantics preserved

- U+FEFF at the very start is dropped.
- A record ends at LF or CRLF; a line with no characters is no record.
- Outside quotes, a CR not followed by LF is dropped (`stray_cr`).
- A field opening with a quote runs to the next non-doubled quote; `""`
  inside is one quote; CRLF / lone CR inside is read as LF.
- What follows the closing quote up to the next comma or line break is
  appended as it stands (`quote_junk`, only when something was kept).
- A quote that never closes is a literal character; the text after it is
  re-read as unquoted (`unterminated_quote`).
- A quote inside an unquoted field is a literal character.
- Fields stay strings, never trimmed or converted.
- `columns` is the first record when `header` is true, else `null`
  (no records + header true → `[]`); rows are the records after it.
- Every record is padded with empty strings (`short_row`, `fields`) or cut
  (`long_row`, `extra`) to the first record's width; the header itself is
  stored as-is.
- Each error is `{ code, line, row }` in the order met; `line` is the
  1-based line its record starts on (counting every LF, CRLF and lone CR
  inside quotes; a lone CR outside quotes does NOT increment line); `row`
  is the record's index in rows (`null` for the header).
- A record that is a single empty unquoted field is skipped entirely
  (its `stray_cr` errors stay).

## Layout

- `solve.js` — the fast parser (`run(input)`).
- `main.ts` — the harness driver, kept verbatim from the house baseline
  (reads `/input/cases.json`, answers each case with `run`, writes
  `/output/answers.json`).
- `package.json` — `{"type": "module"}`.
- `LICENSE` — MIT.
- `.makefun/owner.json` — the account wallet for this entry.
