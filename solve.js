// Fast drop-in for csv-reader 1.0.0 (reference semantics, byte-identical output).
//
// Reads { text, header } and returns { columns, rows, errors }.
// csv-reader 1.0.0 is a one-character-at-a-time parser: it builds every field
// with `value += c` and calls a helper per character. This parser keeps the
// exact same semantics while never touching a character twice:
//
//   - a whole line with no quote and no stray CR is split in C++ (split(','))
//   - a line whose quoted fields all close on the same line is split the
//     same way: the unquoted runs between quoted fields go through
//     split(','), and each quoted field is one slice between two indexOf
//     jumps (doubled quotes folded in the same loop)
//   - anything else (a quoted field spanning lines, an unterminated quote,
//     junk after a closing quote, a stray CR, a quote inside an unquoted
//     field) falls back to a field-by-field scanner that follows the
//     reference step by step
//   - a stray CR inside an unquoted field is dropped (stray_cr) and the
//     field is built from slices around it
//   - lines inside a quoted field are only counted once the quote is
//     confirmed closed; on unterminated_quote they are discarded and the
//     opening quote is re-read as a literal
//
// Semantics (from csv-reader 1.0.0):
//   - a U+FEFF at the very start is dropped
//   - a record ends at LF or CRLF; a line with no characters is no record
//   - outside quotes, a CR not followed by LF is dropped (stray_cr)
//   - a field opening with a quote runs to the next non-doubled quote;
//     `""` inside is one quote; CRLF / lone CR inside is read as LF
//   - what follows the closing quote up to the next comma or line break is
//     appended as it stands (quote_junk, only when something was kept)
//   - a quote that never closes is a literal character; the text after it
//     is re-read as unquoted (unterminated_quote)
//   - a quote inside an unquoted field is a literal character
//   - fields stay strings, never trimmed or converted
//   - columns is the first record when header is true, else null
//     (no records + header true -> []); rows are the records after it
//   - every record is padded with empty strings (short_row, `fields`)
//     or cut (long_row, `extra`) to the first record's width; the header
//     itself is stored as-is
//   - each error is { code, line, row } in the order met; a record's
//     short_row/long_row when the record ends; line is the 1-based line
//     its record starts on (counting every LF, CRLF and lone CR inside
//     quotes; a lone CR outside quotes does NOT increment line);
//     row is the record's index in rows (null for the header)
//   - a record that is a single empty unquoted field (fields == [''] and
//     the field was not quoted) is skipped entirely (its stray_cr errors
//     stay)

const LF = 10;
const CR = 13;
const COMMA = 44;
const QUOTE = 34;

export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;
  const len = text.length;
  let pos = 0;
  let line = 1;

  if (text.charCodeAt(0) === 0xfeff) pos = 1;

  // Per-record state, shared with scanUnquoted.
  let recordLine = 1;
  let recordRow = null;

  // Scans one unquoted field starting at `pos` with the given initial value.
  // Returns 0 (comma), 1 (line break) or 2 (end of input). The value is kept
  // in the closure variable `scanValue`.
  let scanValue = '';
  function scanUnquoted(value) {
    let start = pos;
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === COMMA) {
        scanValue = value === '' ? text.slice(start, pos) : value + text.slice(start, pos);
        pos++;
        return 0;
      }
      if (c === LF) {
        scanValue = value === '' ? text.slice(start, pos) : value + text.slice(start, pos);
        pos++;
        line++;
        return 1;
      }
      if (c === CR) {
        if (text.charCodeAt(pos + 1) === LF) {
          scanValue = value === '' ? text.slice(start, pos) : value + text.slice(start, pos);
          pos += 2;
          line++;
          return 1;
        }
        // Stray CR: dropped, field continues.
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        value += text.slice(start, pos);
        pos++;
        start = pos;
        continue;
      }
      pos++;
    }
    scanValue = value === '' ? text.slice(start, pos) : value + text.slice(start, pos);
    return 2;
  }

  // Stores a finished record, applying the width and header rules.
  // `quoted` is whether the record's only field was a quoted field
  // (relevant only when fields.length === 1 && fields[0] === '').
  function finishRecord(fields, quoted) {
    if (fields.length === 1 && fields[0] === '' && !quoted) return;
    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      return;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  while (true) {
    // Skip empty lines.
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === LF) {
        pos++;
        line++;
      } else if (c === CR && text.charCodeAt(pos + 1) === LF) {
        pos += 2;
        line++;
      } else {
        break;
      }
    }
    if (pos >= len) break;
    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // The record's first line. lineEnd excludes a trailing CRLF \r.
    const nl = text.indexOf('\n', pos);
    const lineEnd = nl === -1 ? len : nl > pos && text.charCodeAt(nl - 1) === CR ? nl - 1 : nl;
    // The line slice bounds every scan below to this line: an unbounded
    // indexOf('\r') on the whole text would scan far past the line in an
    // LF file, where CRs are rare.
    const lineStr = text.slice(pos, lineEnd);
    const hasQuote = lineStr.indexOf('"') !== -1;
    const hasCR = lineStr.indexOf('\r') !== -1;

    if (!hasQuote && !hasCR) {
      // Clean line: split in C++.
      const fields = lineStr.split(',');
      pos = nl === -1 ? len : nl + 1;
      line++;
      finishRecord(fields, false);
      continue;
    }

    if (hasQuote && !hasCR) {
      // Single-line record: every quoted field closes on this line, so
      // the line holds no \n and no \r inside any field. Unquoted runs
      // go through split(','), quoted fields are one slice each.
      // Any shape this cannot prove falls back to the slow path.
      const fields = [];
      let i = pos;
      let hasUnquoted = false;
      let ok = true;
      let done = false;
      while (!done) {
        const q = text.indexOf('"', i);
        if (q === -1 || q >= lineEnd) {
          // No more quotes: the rest is one unquoted run.
          const rest = text.slice(i, lineEnd).split(',');
          for (let k = 0; k < rest.length; k++) fields.push(rest[k]);
          hasUnquoted = true;
          done = true;
          break;
        }
        if (q !== i && text.charCodeAt(q - 1) !== COMMA) {
          ok = false; // quote inside an unquoted field
          break;
        }
        if (q > i) {
          // Unquoted run [i, q): its last character is the comma before
          // the quote, so the fields are [i, q-1) split by ','.
          const runFields = text.slice(i, q - 1).split(',');
          for (let k = 0; k < runFields.length; k++) fields.push(runFields[k]);
          hasUnquoted = true;
        }
        // Quoted field starting at q: jump quote to quote. A segment
        // inside this line holds no \r or \n, so it is used as-is.
        let seg = q + 1;
        let v = '';
        let closed = -1;
        for (;;) {
          const c = text.indexOf('"', seg);
          if (c === -1 || c >= lineEnd) {
            ok = false; // unterminated, or closes on a later line
            break;
          }
          if (text.charCodeAt(c + 1) === QUOTE) {
            // Doubled quote: one literal quote.
            const part = text.slice(seg, c);
            v = v === '' ? part : v + part;
            v += '"';
            seg = c + 2;
            continue;
          }
          const part = text.slice(seg, c);
          v = v === '' ? part : v + part;
          closed = c;
          break;
        }
        if (!ok) break;
        fields.push(v);
        if (closed + 1 >= lineEnd) {
          done = true;
          break;
        }
        const c = text.charCodeAt(closed + 1);
        if (c === COMMA) {
          i = closed + 2;
          continue;
        }
        if (c === LF || (c === CR && text.charCodeAt(closed + 2) === LF)) {
          done = true;
          break;
        }
        ok = false; // junk after the closing quote
        break;
      }
      if (ok) {
        pos = nl === -1 ? len : nl + 1;
        line++;
        finishRecord(fields, fields.length === 1 && !hasUnquoted);
        continue;
      }
      // else fall through to the slow path
    }

    // Slow path: field by field, following the reference step by step.
    const fields = [];
    let quoted = false;
    let ended = 1;
    for (;;) {
      let value;
      if (text.charCodeAt(pos) === QUOTE) {
        quoted = true;
        const open = pos;
        const openLine = line;
        // Scan for the closing quote, jumping quote to quote.
        let start = pos + 1;
        let seg = start;
        let closed = -1;
        let v = '';
        addLines = 0;
        for (;;) {
          const q = text.indexOf('"', seg);
          if (q === -1) break;
          if (text.charCodeAt(q + 1) === QUOTE) {
            // Doubled quote: one literal quote.
            const part = processSegment(text.slice(seg, q));
            v = v === '' ? part : v + part;
            v += '"';
            seg = q + 2;
            continue;
          }
          const part = processSegment(text.slice(seg, q));
          v = v === '' ? part : v + part;
          closed = q;
          break;
        }
        if (closed === -1) {
          // Unterminated quote: the opening quote is a literal and the
          // text after it is re-read as unquoted; any lines inside are
          // discarded (line resets to the opening line).
          errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
          line = openLine;
          pos = open + 1;
          ended = scanUnquoted('"');
          value = scanValue;
          quoted = false;
        } else {
          value = v;
          pos = closed + 1;
          line += addLines;
          if (pos >= len) {
            ended = 2;
          } else {
            const c = text.charCodeAt(pos);
            if (c === COMMA) {
              pos++;
              ended = 0;
            } else if (c === LF) {
              pos++;
              line++;
              ended = 1;
            } else if (c === CR && text.charCodeAt(pos + 1) === LF) {
              pos += 2;
              line++;
              ended = 1;
            } else {
              // Junk after the closing quote, appended as it stands.
              const before = value.length;
              ended = scanUnquoted(value);
              value = scanValue;
              if (value.length > before) {
                errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
              }
            }
          }
        }
      } else {
        quoted = false;
        ended = scanUnquoted('');
        value = scanValue;
      }
      fields.push(value);
      if (ended !== 0) break;
    }
    finishRecord(fields, quoted);
  }

  return { columns: header ? columns ?? [] : null, rows, errors };
}

// Lines counted inside the quoted field just processed. Reset to 0 at the
// start of each quoted field and accumulated by processSegment; read by the
// caller after a confirmed closing quote. (On unterminated_quote the count
// is discarded.)
let addLines = 0;

// Converts a segment inside a quoted field: CRLF and lone CR become LF.
// Counts the line breaks in the segment into addLines. A segment with no
// CR or LF returns as-is (no copy beyond the slice already made).
function processSegment(seg) {
  if (seg.indexOf('\r') === -1) {
    let n = 0;
    let i = -1;
    while ((i = seg.indexOf('\n', i + 1)) !== -1) n++;
    addLines += n;
    return seg;
  }
  const conv = seg.replace(/\r\n?/g, '\n');
  let n = 0;
  let i = -1;
  while ((i = conv.indexOf('\n', i + 1)) !== -1) n++;
  addLines += n;
  return conv;
}
