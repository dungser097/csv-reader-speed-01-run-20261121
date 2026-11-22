// Fast drop-in for csv-reader 1.0.0 (make.fun's own CSV reader): run(input) returns
// exactly csv-reader's {columns, rows, errors} for {text, header}. Written from scratch
// in this session from the reference's stated policy (RULES.txt) and its code, which was
// read only to learn the exact semantics; no code is copied from it.
//
// Semantics (exactly csv-reader 1.0.0):
// - U+FEFF at the very start is dropped. A record ends at LF or CRLF; a line left with
//   no characters is no record. Outside quotes a CR not followed by LF is dropped
//   (error stray_cr). A field opening with a quote runs to the next quote that is not
//   doubled ("" inside is one quote; each CRLF or lone CR inside is read as LF); what
//   follows its closing quote up to the next comma or line break is appended as it
//   stands (quote_junk, when the field ends). A quote that never closes is a literal
//   character and the text after it is read again as unquoted (unterminated_quote).
//   A quote inside an unquoted field is literal. Fields stay strings.
// - columns is the first record when header is true, else null; rows holds the records
//   after it (every record when header is false), each padded with "" (short_row, with
//   fields: its count) or cut (long_row, with extra: the cut fields) to the first
//   record's width. Each error is {code, line, row}, in the order met; line is the
//   1-based line its record starts on (counting every LF, CRLF and lone CR inside
//   quotes), row its record's index in rows (null for the header).
//
// Speed: a hand-tuned single pass. Fields are cut out with String.slice after a
// regex finds the next delimiter, so plain field text is never walked a character at
// a time and no string is built up one character at a time. Quoted fields are one
// slice when they hold no escape, newline or CR; only a field that actually holds one
// of those is assembled from segments. Error records are pushed in scan order, exactly
// as the reference pushes them.

const RE_F = /[",\r\n]/g; // specials that can end or disturb an unquoted field
const RE_Q = /["\r\n]/g; // specials inside a quoted field (a comma there is literal)

const COMMA = 0;
const BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const s = String(input.text);
  const header = input.header === true;
  const n = s.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let i = 0; // next character to read
  let line = 1; // the line that character is on
  if (s.charCodeAt(0) === 0xfeff) i = 1;

  let recordLine = 1; // line the record being read starts on
  let recordRow = null; // index in rows the record being read takes (null: header)

  // Outcome of the unquoted scan just run: the field's value, how it ended, and how
  // many characters it kept (only counted when the caller tracks it, for quote_junk).
  let uVal = '';
  let uEnd = END;
  let uAdd = 0;

  // Reads unquoted characters from i up to the next comma or line break, appending to
  // `prefix` (null: the field starts here). A CR not followed by LF is dropped and
  // recorded as stray_cr. A quote is a literal character. Sets uVal, uEnd, uAdd.
  function readUnquoted(prefix, track) {
    let parts = null; // segments split off by a dropped stray CR
    let start = i;
    let added = 0;
    while (true) {
      RE_F.lastIndex = i;
      if (!RE_F.test(s)) {
        const seg = s.slice(start);
        if (track) added += seg.length;
        uVal = prefix === null ? (parts === null ? seg : parts.join('') + seg) : prefix + (parts === null ? seg : parts.join('') + seg);
        i = n;
        uEnd = END;
        uAdd = added;
        return;
      }
      const j = RE_F.lastIndex - 1;
      const cc = s.charCodeAt(j);
      if (cc === 44) {
        // ',': the field ends, the record goes on.
        const seg = s.slice(start, j);
        if (track) added += seg.length;
        uVal = prefix === null ? (parts === null ? seg : parts.join('') + seg) : prefix + (parts === null ? seg : parts.join('') + seg);
        i = j + 1;
        uEnd = COMMA;
        uAdd = added;
        return;
      }
      if (cc === 10) {
        // LF: the field and the record end.
        const seg = s.slice(start, j);
        if (track) added += seg.length;
        uVal = prefix === null ? (parts === null ? seg : parts.join('') + seg) : prefix + (parts === null ? seg : parts.join('') + seg);
        i = j + 1;
        line += 1;
        uEnd = BREAK;
        uAdd = added;
        return;
      }
      if (cc === 13) {
        // CR: with a following LF it ends the record; alone it is dropped (stray_cr).
        if (s.charCodeAt(j + 1) === 10) {
          const seg = s.slice(start, j);
          if (track) added += seg.length;
          uVal = prefix === null ? (parts === null ? seg : parts.join('') + seg) : prefix + (parts === null ? seg : parts.join('') + seg);
          i = j + 2;
          line += 1;
          uEnd = BREAK;
          uAdd = added;
          return;
        }
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        const seg0 = s.slice(start, j);
        if (track) added += seg0.length; // kept characters count toward quote_junk
        (parts ??= []).push(seg0);
        i = j + 1;
        start = j + 1;
        continue;
      }
      // '"': a literal character inside an unquoted field; the field goes on.
      i = j + 1;
    }
  }

  while (true) {
    // Lines with no characters are no records.
    while (i < n) {
      const c = s.charCodeAt(i);
      if (c === 10) {
        i += 1;
        line += 1;
      } else if (c === 13 && s.charCodeAt(i + 1) === 10) {
        i += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (i >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let ended;
    let quoted = false;
    do {
      if (s.charCodeAt(i) === 34) {
        // A quoted field: runs to the next quote that is not doubled.
        quoted = true;
        const open = i;
        const openLine = line;
        i += 1;
        let qstart = i;
        let qparts = null;
        let qval;
        let closed = false;
        while (true) {
          RE_Q.lastIndex = i;
          if (!RE_Q.test(s)) break; // no closing quote in the rest of the text
          const j = RE_Q.lastIndex - 1;
          const cc = s.charCodeAt(j);
          if (cc === 34) {
            if (s.charCodeAt(j + 1) === 34) {
              // "" inside: one quote.
              (qparts ??= []).push(s.slice(qstart, j), '"');
              i = j + 2;
              qstart = j + 2;
              continue;
            }
            qval = qparts === null ? s.slice(qstart, j) : qparts.join('') + s.slice(qstart, j);
            i = j + 1;
            closed = true;
            break;
          }
          // CR or LF inside quotes: read as one LF.
          (qparts ??= []).push(s.slice(qstart, j), '\n');
          line += 1;
          i = cc === 13 && s.charCodeAt(j + 1) === 10 ? j + 2 : j + 1;
          qstart = i;
        }
        if (!closed) {
          // The quote never closes: it is a literal character, and the text after it
          // is read again as unquoted.
          i = open + 1;
          line = openLine;
          errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
          readUnquoted('"', false);
          fields.push(uVal);
          ended = uEnd;
          continue;
        }
        if (i >= n) {
          fields.push(qval);
          ended = END;
          continue;
        }
        const c = s.charCodeAt(i);
        if (c === 44) {
          i += 1;
          fields.push(qval);
          ended = COMMA;
          continue;
        }
        if (c === 10) {
          i += 1;
          line += 1;
          fields.push(qval);
          ended = BREAK;
          continue;
        }
        if (c === 13 && s.charCodeAt(i + 1) === 10) {
          i += 2;
          line += 1;
          fields.push(qval);
          ended = BREAK;
          continue;
        }
        // What follows the closing quote is appended as it stands, up to the next
        // comma or line break.
        readUnquoted(qval, true);
        if (uAdd > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
        fields.push(uVal);
        ended = uEnd;
      } else {
        quoted = false;
        readUnquoted(null, false);
        fields.push(uVal);
        ended = uEnd;
      }
    } while (ended === COMMA);

    // A line that held only stray CRs is left with no characters: no record (its
    // stray_cr errors stay).
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
