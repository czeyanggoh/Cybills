// The smallest .xlsx this app needs, written and read without a library.
//
// An .xlsx is a ZIP of XML files. Writing one needs no compression at all —
// every reader accepts STORED entries — and reading one needs only raw inflate,
// which both the browser and Node carry as DecompressionStream('deflate-raw').
// So the whole format is this file rather than a megabyte of dependency, and the
// same code runs under `npm test`.
//
// Pure: no DOM, no fetch. `writeXlsx` returns bytes; `readXlsx` takes bytes.

const enc = new TextEncoder();
const dec = new TextDecoder();

// --- ZIP ---------------------------------------------------------------------

let crcTable = null;
function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// Every entry STORED (method 0): files this size gain nothing from deflate, and
// a stored entry is the one shape no reader can get wrong.
function zipStore(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of files) {
    const nameBytes = enc.encode(name);
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, 0, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, nameBytes.length, true);
    parts.push(new Uint8Array(local.buffer), nameBytes, data);

    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, 0, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, data.length, true);
    cd.setUint32(24, data.length, true);
    cd.setUint16(28, nameBytes.length, true);
    cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const cdSize = central.reduce((n, p) => n + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of all) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Read through the CENTRAL directory, not the local headers: a file written by
// a streaming zipper leaves the sizes out of the local header and puts them in
// a descriptor after the data, where only the directory says where it ends.
async function unzip(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not_xlsx');
  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  const files = {};
  for (let n = 0; n < count; n++) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error('not_xlsx');
    const method = view.getUint16(at + 10, true);
    const size = view.getUint32(at + 20, true);
    const nameLen = view.getUint16(at + 28, true);
    const extraLen = view.getUint16(at + 30, true);
    const commentLen = view.getUint16(at + 32, true);
    const localAt = view.getUint32(at + 42, true);
    const name = dec.decode(bytes.subarray(at + 46, at + 46 + nameLen));
    const dataAt = localAt + 30 + view.getUint16(localAt + 26, true) + view.getUint16(localAt + 28, true);
    const raw = bytes.subarray(dataAt, dataAt + size);
    files[name] = { method, raw };
    at += 46 + nameLen + extraLen + commentLen;
  }
  return {
    has: (name) => Boolean(files[name]),
    async text(name) {
      const f = files[name];
      if (!f) return '';
      if (f.method === 0) return dec.decode(f.raw);
      if (f.method === 8) return dec.decode(await inflateRaw(f.raw));
      throw new Error('unsupported_compression');
    },
  };
}

// --- XML ---------------------------------------------------------------------

const xmlEscape = (s) =>
  String(s ?? '')
    // Characters XML 1.0 cannot carry at all — a stray one makes Excel refuse
    // the whole file as corrupt.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function xmlUnescape(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    // OOXML's own escape for characters XML can't hold (_x000D_ for a CR).
    .replace(/_x([0-9a-f]{4})_/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function attrs(src) {
  const out = {};
  for (const m of String(src).matchAll(/([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
    out[m[1]] = xmlUnescape(m[3] ?? m[4] ?? '');
  }
  return out;
}

// The text of a <si> or an <is>: every <t> run joined, phonetic guides left out.
function runsText(xml) {
  const body = String(xml).replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  let out = '';
  for (const m of body.matchAll(/<t\b[^>]*?(?:\/>|>([\s\S]*?)<\/t>)/g)) out += xmlUnescape(m[1] ?? '');
  return out;
}

// "AB12" -> 27 (zero-based column).
function colIndex(ref) {
  const letters = String(ref).match(/^[A-Z]+/i)?.[0]?.toUpperCase() || '';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export function colLetter(index) {
  let n = index + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// --- Write -------------------------------------------------------------------

// Style indexes into the cellXfs below.
const STYLE = { plain: 0, header: 1, readOnly: 2 };

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><sz val="11"/><color rgb="FF6B7280"/><name val="Calibri"/></font></fonts>
<fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE5E7EB"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF3F4F6"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="3"><xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="49" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyNumberFormat="1"/><xf numFmtId="49" fontId="2" fillId="3" borderId="0" xfId="0" applyFont="1" applyFill="1" applyNumberFormat="1"/></cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

function cell(ref, value, style) {
  const s = style ? ` s="${style}"` : '';
  const v = value == null ? '' : String(value);
  if (!v) return style ? `<c r="${ref}"${s}/>` : '';
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${xmlEscape(v)}</t></is></c>`;
}

// A sheet: { name, columns: [{ header, width, readOnly }], rows: [[...]],
// validations: [{ col, source }], frozen }. Every cell is text (format "@"), so
// a mobile number or a project called "0012" survives the round trip intact.
function sheetXml(sheet) {
  const cols = sheet.columns || [];
  const rows = sheet.rows || [];
  const last = colLetter(Math.max(0, cols.length - 1));
  const out = [];
  out.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>');
  out.push('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">');
  out.push(`<dimension ref="A1:${last}${rows.length + 1}"/>`);
  out.push(
    sheet.frozen
      ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
      : '<sheetViews><sheetView workbookViewId="0"/></sheetViews>'
  );
  out.push('<sheetFormatPr defaultRowHeight="15"/>');
  if (cols.length) {
    out.push('<cols>');
    cols.forEach((c, i) => {
      const style = c.readOnly ? ` style="${STYLE.readOnly}"` : ` style="${STYLE.plain}"`;
      out.push(`<col min="${i + 1}" max="${i + 1}" width="${c.width || 16}" customWidth="1"${style}/>`);
    });
    out.push('</cols>');
  }
  out.push('<sheetData>');
  out.push(`<row r="1">${cols.map((c, i) => cell(`${colLetter(i)}1`, c.header, STYLE.header)).join('')}</row>`);
  rows.forEach((row, r) => {
    const n = r + 2;
    const cells = cols.map((c, i) => cell(`${colLetter(i)}${n}`, row[i], c.readOnly ? STYLE.readOnly : 0)).join('');
    out.push(`<row r="${n}">${cells}</row>`);
  });
  out.push('</sheetData>');
  if (sheet.autoFilter && cols.length) out.push(`<autoFilter ref="A1:${last}${rows.length + 1}"/>`);
  const validations = (sheet.validations || []).filter((v) => v.source && rows.length);
  if (validations.length) {
    out.push(`<dataValidations count="${validations.length}">`);
    for (const v of validations) {
      const L = colLetter(v.col);
      out.push(
        `<dataValidation type="list" allowBlank="1" showErrorMessage="1" errorStyle="stop" errorTitle="${xmlEscape(v.errorTitle || 'Not on the list')}" error="${xmlEscape(v.error || 'Pick a value from the list.')}" sqref="${L}2:${L}${rows.length + 1}"><formula1>${xmlEscape(v.source)}</formula1></dataValidation>`
      );
    }
    out.push('</dataValidations>');
  }
  out.push('<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>');
  out.push('</worksheet>');
  return out.join('');
}

export function writeXlsx(sheets) {
  const names = sheets.map((s) => String(s.name || 'Sheet').replace(/[\\/?*[\]:]/g, ' ').slice(0, 31));
  const files = [];
  const add = (name, text) => files.push({ name, data: enc.encode(text) });
  add(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets
      .map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
      .join('')}</Types>`
  );
  add(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'
  );
  // The filter's hidden name is what makes Excel draw the dropdown arrows on
  // the header row it was asked for.
  const filters = sheets
    .map((s, i) =>
      s.autoFilter && s.columns?.length
        ? `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${xmlEscape(names[i])}'!$A$1:$${colLetter(s.columns.length - 1)}$${(s.rows?.length || 0) + 1}</definedName>`
        : ''
    )
    .join('');
  add(
    'xl/workbook.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView/></bookViews><sheets>${names
      .map((n, i) => `<sheet name="${xmlEscape(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
      .join('')}</sheets>${filters ? `<definedNames>${filters}</definedNames>` : ''}</workbook>`
  );
  add(
    'xl/_rels/workbook.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
      .map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
      .join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`
  );
  add('xl/styles.xml', STYLES_XML);
  sheets.forEach((s, i) => add(`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s)));
  return zipStore(files);
}

// --- Read --------------------------------------------------------------------

// Every sheet as rows of strings, in workbook order: [{ name, rows }]. A cell
// is its displayed text where that is stored (shared and inline strings), else
// its raw value; a boolean reads as TRUE / FALSE.
export async function readXlsx(bytes) {
  const zip = await unzip(bytes);
  if (!zip.has('xl/workbook.xml')) throw new Error('not_xlsx');
  const workbook = await zip.text('xl/workbook.xml');
  const rels = await zip.text('xl/_rels/workbook.xml.rels');
  const targets = {};
  for (const m of rels.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const a = attrs(m[1]);
    if (a.Id && a.Target) targets[a.Id] = a.Target;
  }
  const shared = [];
  const sstName = zip.has('xl/sharedStrings.xml') ? 'xl/sharedStrings.xml' : '';
  if (sstName) {
    for (const m of (await zip.text(sstName)).matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g)) shared.push(runsText(m[1] ?? ''));
  }
  const sheets = [];
  for (const m of workbook.matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const a = attrs(m[1]);
    const rid = Object.entries(a).find(([k]) => k === 'r:id' || /:id$/.test(k))?.[1];
    let target = targets[rid] || '';
    if (!target) continue;
    // Relative to xl/, or absolute from the package root.
    target = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
    const xml = await zip.text(target);
    sheets.push({ name: a.name || '', rows: parseSheet(xml, shared) });
  }
  return sheets;
}

function parseSheet(xml, shared) {
  const rows = [];
  const data = xml.match(/<sheetData\b[^>]*>([\s\S]*?)<\/sheetData>/)?.[1] || '';
  let rowNo = 0;
  for (const rm of data.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const ra = attrs(rm[1]);
    rowNo = ra.r ? Number(ra.r) : rowNo + 1;
    const row = [];
    let col = -1;
    for (const cm of String(rm[2] || '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ca = attrs(cm[1]);
      col = ca.r ? colIndex(ca.r) : col + 1;
      const body = cm[2] || '';
      let value = '';
      if (ca.t === 'inlineStr') value = runsText(body.match(/<is\b[^>]*>([\s\S]*?)<\/is>/)?.[1] || '');
      else {
        const v = body.match(/<v\b[^>]*>([\s\S]*?)<\/v>/)?.[1];
        if (v != null) {
          const raw = xmlUnescape(v);
          if (ca.t === 's') value = shared[Number(raw)] ?? '';
          else if (ca.t === 'b') value = raw === '1' ? 'TRUE' : 'FALSE';
          else value = raw;
        }
      }
      row[col] = value;
    }
    for (let i = 0; i < row.length; i++) if (row[i] == null) row[i] = '';
    rows[rowNo - 1] = row;
  }
  for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];
  return rows;
}
