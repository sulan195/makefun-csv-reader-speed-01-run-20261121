// csv-reader-speed: a faster drop-in for csv-reader 1.0.0.
//
// run(input) returns exactly what csv-reader 1.0.0 returns for the same
// input {text, header}: {columns, rows, errors}. The reading policy is the
// one RULES.txt states, implemented here as a single left-to-right pass that
// slices fields out of the text instead of building them one character at a
// time (the reference builds every field character by character, which is
// where its CPU time goes).
//
// Scanning strategy:
// - An unquoted field ends at the next comma, LF or CR. The next positions
//   of the three are cached and rescanned only when stale, so a text with no
//   CR at all (or a single-column text with no comma) never rescans to the
//   end of the text per field; the field itself is one slice, except that a
//   lone CR outside quotes is dropped and reported (stray_cr) and the scan
//   then resumes. The only backward jump of the scan is the
//   unterminated-quote reset, which clears the cache.
// - A quoted field is one slice when its closing quote (indexOf) has no
//   doubled quote after it and the cached next LF/CR lie past it (the common
//   case). A doubled quote or a CR/LF inside the field takes a slow path
//   that walks the field with a global regex over quote/CR/LF, turning ""
//   into " and every CRLF or lone CR inside quotes into LF, exactly as the
//   reference does.
// - `line` is kept incrementally: every LF, CRLF and lone CR inside quotes
//   counts, as does every record-terminating line break and every skipped
//   empty line, so each error's line is the line its record starts on.
// - Errors are pushed in the order they are met, with the record's start
//   line and its index in rows (null for the header row).
//
// Pure: no clock, no randomness, no locale, nothing kept from one call to
// the next. Deterministic: the same input always yields the same answer.

const COMMA = 0; // field ended at a comma: the record goes on
const LINE_BREAK = 1; // field ended at a line break: the record ends
const END = 2; // field ended at the end of the text: the record ends

const CHAR_COMMA = 44; // ','
const CHAR_LF = 10; // '\n'
const CHAR_CR = 13; // '\r'
const CHAR_QUOTE = 34; // '"'
const CHAR_BOM = 0xfeff; // U+FEFF

// Characters that need handling inside a quoted field.
const QUOTED_SPECIAL = /["\r\n]/g;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  const len = text.length;
  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (text.charCodeAt(0) === CHAR_BOM) pos = 1;

  // The record being read: the line it starts on and the index in rows it
  // takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  // How the last field read ended, and how many characters the last
  // unquoted read appended to its base value (for quote_junk).
  let lastEnded = END;
  let lastAdded = 0;

  // Cached positions of the next comma, LF and CR at or after the last
  // scan point: -1 means "not scanned yet", len means "none to the end".
  // A cached position stays the true next occurrence while pos only moves
  // forward (the only backward jump is the unterminated-quote reset, which
  // clears all three). Without the cache, a text with no CR at all would
  // make every field scan to the end of the text for one.
  let nextComma = -1;
  let nextLF = -1;
  let nextCR = -1;

  function idxOrLen(ch, from) {
    const i = text.indexOf(ch, from);
    return i === -1 ? len : i;
  }

  function error(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // Reads unquoted characters onto `base` up to the next comma or line
  // break: a CR not followed by LF is dropped (stray_cr). Returns the field
  // and sets lastEnded / lastAdded; `lastAdded` counts the characters kept.
  // The next delimiter comes from the cached positions (rescanned only when
  // stale) and the field is one slice.
  function readUnquoted(base) {
    let value = base;
    let added = 0;
    for (;;) {
      if (nextComma < pos) nextComma = idxOrLen(',', pos);
      if (nextLF < pos) nextLF = idxOrLen('\n', pos);
      if (nextCR < pos) nextCR = idxOrLen('\r', pos);
      let d = nextComma;
      if (nextLF < d) d = nextLF;
      if (nextCR < d) d = nextCR;
      if (d >= len) {
        if (pos < len) {
          value += text.slice(pos, len);
          added += len - pos;
        }
        pos = len;
        lastEnded = END;
        lastAdded = added;
        return value;
      }
      if (d > pos) {
        value += text.slice(pos, d);
        added += d - pos;
      }
      const ch = text.charCodeAt(d);
      if (ch === CHAR_COMMA) {
        pos = d + 1;
        lastEnded = COMMA;
        lastAdded = added;
        return value;
      }
      if (ch === CHAR_LF) {
        pos = d + 1;
        line += 1;
        lastEnded = LINE_BREAK;
        lastAdded = added;
        return value;
      }
      // A CR: a line break when followed by LF, else a dropped stray CR.
      if (text.charCodeAt(d + 1) === CHAR_LF) {
        pos = d + 2;
        line += 1;
        lastEnded = LINE_BREAK;
        lastAdded = added;
        return value;
      }
      error('stray_cr');
      pos = d + 1;
    }
  }

  // Reads a quoted field whose opening quote is at pos. Returns the field
  // and sets lastEnded / lastAdded.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    pos += 1;
    // A quote at q with no doubled quote after it is the closing quote of
    // a clean field when no LF or CR lies before it (the cached next
    // positions tell); a doubled quote, or a CR/LF inside, takes the slow
    // path below.
    if (nextLF < pos) nextLF = idxOrLen('\n', pos);
    if (nextCR < pos) nextCR = idxOrLen('\r', pos);
    const q = text.indexOf('"', pos);
    if (q === -1) {
      // The quote never closes: it is a literal character, and the text
      // after it is read again as unquoted.
      pos = open + 1;
      line = openLine;
      nextComma = -1;
      nextLF = -1;
      nextCR = -1;
      error('unterminated_quote');
      return readUnquoted('"');
    }
    if (text.charCodeAt(q + 1) !== CHAR_QUOTE && nextLF > q && nextCR > q) {
      const value = text.slice(pos, q);
      pos = q + 1;
      if (pos >= len) {
        lastEnded = END;
        lastAdded = 0;
        return value;
      }
      const c = text.charCodeAt(pos);
      if (c === CHAR_COMMA) {
        pos += 1;
        lastEnded = COMMA;
        lastAdded = 0;
        return value;
      }
      if (c === CHAR_LF) {
        pos += 1;
        line += 1;
        lastEnded = LINE_BREAK;
        lastAdded = 0;
        return value;
      }
      if (c === CHAR_CR && text.charCodeAt(pos + 1) === CHAR_LF) {
        pos += 2;
        line += 1;
        lastEnded = LINE_BREAK;
        lastAdded = 0;
        return value;
      }
      // What follows the closing quote is appended as it stands, up to the
      // next comma or line break.
      const junk = readUnquoted(value);
      if (lastAdded > 0) error('quote_junk');
      return junk;
    }
    // Slow path: doubled quotes and/or line breaks inside the field.
    let value = '';
    let p = pos;
    for (;;) {
      QUOTED_SPECIAL.lastIndex = p;
      const m = QUOTED_SPECIAL.exec(text);
      if (m === null) {
        // The quote never closes: it is a literal character, and the text
        // after it is read again as unquoted.
        pos = open + 1;
        line = openLine;
        nextComma = -1;
        nextLF = -1;
        nextCR = -1;
        error('unterminated_quote');
        return readUnquoted('"');
      }
      const s = m.index;
      const ch = text.charCodeAt(s);
      if (ch === CHAR_QUOTE) {
        if (text.charCodeAt(s + 1) === CHAR_QUOTE) {
          value += text.slice(p, s);
          value += '"';
          p = s + 2;
          continue;
        }
        value += text.slice(p, s);
        pos = s + 1;
        if (pos >= len) {
          lastEnded = END;
          lastAdded = 0;
          return value;
        }
        const c = text.charCodeAt(pos);
        if (c === CHAR_COMMA) {
          pos += 1;
          lastEnded = COMMA;
          lastAdded = 0;
          return value;
        }
        if (c === CHAR_LF) {
          pos += 1;
          line += 1;
          lastEnded = LINE_BREAK;
          lastAdded = 0;
          return value;
        }
        if (c === CHAR_CR && text.charCodeAt(pos + 1) === CHAR_LF) {
          pos += 2;
          line += 1;
          lastEnded = LINE_BREAK;
          lastAdded = 0;
          return value;
        }
        // What follows the closing quote is appended as it stands, up to
        // the next comma or line break.
        const junk = readUnquoted(value);
        if (lastAdded > 0) error('quote_junk');
        return junk;
      }
      if (ch === CHAR_CR) {
        // CRLF and a lone CR inside quotes are each one LF.
        value += text.slice(p, s);
        value += '\n';
        line += 1;
        p = text.charCodeAt(s + 1) === CHAR_LF ? s + 2 : s + 1;
        continue;
      }
      // A LF inside quotes.
      value += text.slice(p, s);
      value += '\n';
      line += 1;
      p = s + 1;
    }
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < len) {
      const ch = text.charCodeAt(pos);
      if (ch === CHAR_LF) {
        pos += 1;
        line += 1;
      } else if (ch === CHAR_CR && text.charCodeAt(pos + 1) === CHAR_LF) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let quoted;
    do {
      quoted = text.charCodeAt(pos) === CHAR_QUOTE;
      fields.push(quoted ? readQuoted() : readUnquoted(''));
    } while (lastEnded === COMMA);

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
