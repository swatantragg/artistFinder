// The verified-artists export as an .xlsx workbook, in the layout of the artist directory (domain/exports.ts): an Index
// sheet, then one sheet per letter pair. "Social link" spans one column per platform (two header rows, merged cells).
import * as XLSX from 'xlsx';
import { LETTER_SHEETS, type ExportRow, type VerifiedExport } from '../domain/exports';

const MAX_CELL = 32_000;   // Excel keeps at most 32,767 characters in a cell
function titlesCell(titles: string[]): string {
  if (!titles.length) return 'no lead-artist songs found';
  let out = '';
  for (let i = 0; i < titles.length; i++) {
    const next = out ? `${out} | ${titles[i]}` : titles[i];
    if (next.length > MAX_CELL - 40) return `${out} | … and ${titles.length - i} more`;
    out = next;
  }
  return out;
}

export function verifiedWorkbook(data: VerifiedExport): Buffer {
  const wb = XLSX.utils.book_new();
  const P = data.platforms, n = P.length;
  const after = ['Confidence %', 'Link basis', 'Songs', 'Followers', 'Listeners', 'Verified', 'Core member', 'Song titles'];
  const head1 = ['#', 'Artist name', 'Social link', ...Array<string>(n - 1).fill(''), ...after];
  const head2 = ['', '', ...P, ...Array<string>(after.length).fill('')];
  const sheets = LETTER_SHEETS.map(name => ({ name, rows: data.rows.filter(r => r.sheet === name) })).filter(s => s.rows.length);
  const withLink = (rows: ExportRow[]) => rows.filter(r => Object.keys(r.links).length).length;

  const date = data.generatedAt.slice(0, 10);
  const index: (string | number)[][] = [
    ['Goongoonalo - verified artists with social links'], [],
    ['Source', `ArtistFinder verified artists, exported ${date} by ${data.by}`],
    ['Total names', data.rows.length],
    ['Layout', 'One sheet per letter pair, names sorted A-Z within each sheet (as in the artist directory)'], [],
    ['SOCIAL LINK COLUMNS - WHAT THEY MEAN'],
    ['One column per platform', 'The artist’s own profile on that platform, verified by a person in ArtistFinder. Blank = no verified profile there.'],
    ['Other', 'Verified profiles on any other platform'],
    ['Confidence % / Link basis', 'As in the artist directory: the research behind its original social link'],
    ['Songs', 'Songs today: the bigger of the directory count and the songs linked in ArtistFinder'],
    ['Verified / Core member', 'As in the artist directory (Admin Studio)'],
    ['Song titles', 'Songs linked to the artist in ArtistFinder, A-Z'], [],
    ['Sheet', 'Names', 'With a link'],
    ...sheets.map(s => [s.name, s.rows.length, withLink(s.rows)]),
    ['TOTAL', data.rows.length, withLink(data.rows)],
  ];
  const iws = XLSX.utils.aoa_to_sheet(index);
  iws['!cols'] = [{ wch: 28 }, { wch: 100 }, { wch: 12 }];
  XLSX.utils.book_append_sheet(wb, iws, 'Index');

  for (const s of sheets) {
    const body = s.rows.map((r, i) => [
      i + 1, r.name, ...P.map(p => (r.links[p] ?? []).join(' | ')),
      r.confidence ?? '', r.basis, r.songs, r.followers ?? '', r.listeners ?? '', r.verified ? 'Yes' : '', r.core ? 'Yes' : '', titlesCell(r.titles),
    ]);
    const ws = XLSX.utils.aoa_to_sheet([head1, head2, ...body]);
    // "#" and "Artist name" span both header rows, "Social link" spans its platform columns, the rest span both rows
    const merges = [{ s: { r: 0, c: 0 }, e: { r: 1, c: 0 } }, { s: { r: 0, c: 1 }, e: { r: 1, c: 1 } }, { s: { r: 0, c: 2 }, e: { r: 0, c: 1 + n } }];
    for (let c = 2 + n; c < head1.length; c++) merges.push({ s: { r: 0, c }, e: { r: 1, c } });
    ws['!merges'] = merges;
    // a single link per cell is clickable
    s.rows.forEach((r, i) => P.forEach((p, j) => {
      const urls = r.links[p] ?? [];
      const cell = ws[XLSX.utils.encode_cell({ r: i + 2, c: 2 + j })];
      if (cell && urls.length === 1) cell.l = { Target: urls[0] };
    }));
    ws['!cols'] = [{ wch: 5 }, { wch: 28 }, ...P.map(() => ({ wch: 34 })), { wch: 13 }, { wch: 50 }, { wch: 8 }, { wch: 10 }, { wch: 10 }, { wch: 9 }, { wch: 12 }, { wch: 90 }];
    XLSX.utils.book_append_sheet(wb, ws, s.name);
  }
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}
