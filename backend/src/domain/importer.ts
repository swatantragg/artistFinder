// Import pipeline (v2 §3-7, §32-33, §37): FILE → TYPE + ENCODING → HEADER → COLUMN MAPPING → ROW VALIDATION →
// NORMALIZATION → ARTISTS / SONGS / CREDITS → MATCHING → RESULTS. Layouts:
//  - G Amplify standard CSV: one row per track with artist_id, artist_name, artist_role, track_id, title, label, distributor, credits …
//  - catalogue exports (Goongoonalo Media Library export, distributor sheets with Track Name / Artist Name / Lyric Writer …):
//    columns are mapped by name, several artists in one cell become separate artists, no artist IDs so artists are matched
//    by name plus catalogue evidence and never merged on name alone
//  - artist directory (Excel/CSV with "Artist name", "Social link", "Confidence %"): adds profile links as routes
// Every row is kept with its raw values and the mapped fields, so any artist or song can be traced back to its source row.
import { CREDIT_ROLES, IMPORT_CLASSES, type CreditRole, type ImportClass } from './constants';
import { openDuplicate, scanDuplicates } from './dedupe';
import { findHeader, normDate, parseRoleCredits, splitArtists, type ColumnMap, type Field } from './importmap';
import type { Model } from './model';
import { audit, computePriority, evidenceChanged, newCaseRecord, notify, requirePerm, setStage, syncNextAction } from './ops';
import { applyLeads, emptyOutcome, leadsForTracks } from './refresh';
import { kindOf, reopenArtist, syncArtistStatuses } from './status';
import { syncRouteGraph, syncTrackGraph } from './graph';
import { queueJob, searchBlocked } from './discovery/pipeline';
import type { ArtistCase, Ctx, ImportBatch, ImportFormat, ImportRow, ImportSummary, Track } from './types';
import { ISRC_RE, clean, nameKey, normIsrc } from './util';

export const STANDARD_COLUMNS = ['artist_id', 'artist_name', 'artist_role', 'track_id', 'release_id', 'release_title', 'title', 'version', 'isrc', 'label', 'distributor', 'language', 'release_date', 'credits', 'claim_status', 'activity', 'profile_url'];
/** An empty G Amplify standard file (header row only) to fill in by hand. */
export const templateCsv = (): string => `${STANDARD_COLUMNS.join(',')}\n`;
export const REQUIRED_COLUMNS = ['artist_id', 'artist_name', 'artist_role', 'track_id', 'title', 'label', 'distributor'];
export const IMPORT_STEPS = ['Uploading', 'Validating', 'Matching', 'Detecting changes', 'Updating cases', 'Creating tasks', 'Complete'] as const;

export interface ImportInput {
  filename: string;
  checksum: string;
  table?: string[][];                              // parsed CSV
  sheets?: { name: string; rows: unknown[][] }[];  // parsed workbook
  importType?: 'Full' | 'Incremental';
  exportDate?: string;
  source?: string;
  versionOfId?: string | null;
  encoding?: string;
  delimiter?: string;
}
interface CreditIn { id: string | null; name: string; role: CreditRole }
interface Rec {
  rowNumber: number;
  raw: Record<string, string>;
  mapped: Record<string, string>;
  error?: string;
  artistId: string; artistName: string; artistRole: CreditRole;
  /** further lead artists named in the same cell ("A, B"): each is an artist on the song */
  moreLeads: { name: string; role: CreditRole }[];
  trackId: string; releaseId: string; releaseTitle: string; title: string; version: string; isrc: string; label: string; distributor: string;
  language: string; releaseDate: string; credits: CreditIn[]; claimStatus: string; activity: string; profileUrl: string; provisional: boolean;
}

export function normRole(v: string): CreditRole {
  const r = clean(v).toLowerCase();
  if (!r) return 'Other';
  if (/sing|vocal/.test(r)) return 'Singer';
  if (/compos|music director|music by/.test(r)) return 'Composer';
  if (/lyric|writer|words/.test(r)) return 'Lyricist';
  if (/produc|mix|master|arrang/.test(r)) return 'Producer';
  if (/perform|artist|lead|featur|band/.test(r)) return 'Performer';
  const exact = CREDIT_ROLES.find(x => x.toLowerCase() === r);
  return exact ?? 'Other';
}

// ------------------------------------------------------------------ layout detection
const isStandardHead = (h: string[]) => h.includes('artist_id') || (h.includes('track_id') && h.includes('artist_name'));
const isDirectoryHead = (h: string[]) => h.includes('artist name') && (h.includes('social link') || h.includes('confidence %') || h.includes('link basis')) && !h.some(x => ['title', 'track name', 'song', 'song name', 'isrc'].includes(x));
interface Layout { format: ImportFormat; table: string[][]; headerRow: number; map: ColumnMap | null }

/** Finds the format and the header row in a CSV table or the best sheet of a workbook. */
export function detectLayout(input: ImportInput): Layout | null {
  const tables: string[][][] = input.sheets ? input.sheets.map(s => s.rows.map(r => (r ?? []).map(v => String(v ?? '')))) : [input.table ?? []];
  let directory: Layout | null = null;
  let best: { layout: Layout; score: number } | null = null;
  for (const t of tables) {
    const head = (t[0] ?? []).map(x => clean(x).toLowerCase());
    if (isStandardHead(head)) return { format: 'G Amplify standard', table: t, headerRow: 0, map: null };
    const found = findHeader(t);
    if (found) {
      const lower = found.map.header.map(h => h.toLowerCase());
      const format: ImportFormat = lower.includes('leadartists') && lower.includes('audiocredits') ? 'Media Library export' : 'Catalogue export';
      const score = found.map.mapping.length;
      if (!best || score > best.score) best = { layout: { format, table: t, headerRow: found.row, map: found.map }, score };
      continue;
    }
    const hi = t.slice(0, 12).findIndex(r => r.some(v => clean(v).toLowerCase() === 'artist name'));
    if (hi >= 0 && !directory && isDirectoryHead((t[hi] ?? []).map(x => clean(x).toLowerCase()))) directory = { format: 'Artist directory', table: t, headerRow: hi, map: null };
  }
  return best?.layout ?? directory;
}
export function detectFormat(input: ImportInput): ImportFormat | null { return detectLayout(input)?.format ?? null; }
/** Kept for callers that only need a CSV-like table from a workbook. */
export function tableFromSheets(sheets: { name: string; rows: unknown[][] }[]): string[][] | null {
  const l = detectLayout({ filename: '', checksum: '', sheets });
  return l && l.format !== 'Artist directory' ? l.table : null;
}

// ------------------------------------------------------------------ rows → records
function objectRows(table: string[][]): { header: string[]; rows: Record<string, string>[] } {
  const header = (table[0] ?? []).map(h => clean(h));
  const lower = header.map(h => h.toLowerCase());
  const rows = table.slice(1).map(cells => { const o: Record<string, string> = {}; lower.forEach((h, i) => { o[h] = cells[i] ?? ''; }); return o; });
  return { header, rows };
}
function parseCreditList(v: string): { credits: CreditIn[]; error?: string } {
  const credits: CreditIn[] = [];
  for (const part of String(v ?? '').split(';')) {
    const s = part.trim();
    if (!s) continue;
    const bits = s.split('|').map(x => x.trim());
    let id: string | null = null, name = '', role = '';
    if (bits.length === 3) [id, name, role] = bits;
    else if (bits.length === 2) [name, role] = bits;
    else return { credits, error: `Malformed credit “${s}” (use id|name|role)` };
    if (!name || !role) return { credits, error: `Malformed credit “${s}” (name and role are required)` };
    credits.push({ id: id || null, name: clean(name), role: normRole(role) });
  }
  return { credits };
}
function standardRecs(table: string[][]): { recs: Rec[]; missingColumns: string[] } {
  const { header, rows } = objectRows(table);
  const lower = header.map(h => h.toLowerCase());
  const missingColumns = REQUIRED_COLUMNS.filter(c => !lower.includes(c));
  const recs = rows.map((r, i): Rec => {
    const pc = parseCreditList(r.credits);
    const rec: Rec = {
      rowNumber: i + 2, raw: Object.fromEntries(header.map((h, j) => [h, r[lower[j]] ?? ''])), mapped: {}, artistId: clean(r.artist_id), artistName: clean(r.artist_name), artistRole: normRole(r.artist_role), moreLeads: [],
      trackId: clean(r.track_id), releaseId: clean(r.release_id), releaseTitle: clean(r.release_title), title: clean(r.title), version: clean(r.version), isrc: normIsrc(r.isrc), label: clean(r.label),
      distributor: clean(r.distributor), language: clean(r.language), releaseDate: clean(r.release_date).slice(0, 10), credits: pc.credits,
      claimStatus: clean(r.claim_status).toLowerCase(), activity: clean(r.activity), profileUrl: clean(r.profile_url), provisional: false,
    };
    rec.mapped = mappedOf(rec);
    if (missingColumns.length) rec.error = `Unknown layout: missing column(s) ${missingColumns.join(', ')}`;
    else if (!rec.artistId) rec.error = 'Missing stable artist identifier (artist_id)';
    else if (!rec.trackId) rec.error = 'Missing track ID (track_id)';
    else if (!rec.artistName) rec.error = 'Missing artist name';
    else if (!rec.title) rec.error = 'Missing song title';
    else if (!clean(r.artist_role)) rec.error = 'Missing artist role';
    else if (pc.error) rec.error = pc.error;
    return rec;
  });
  return { recs, missingColumns };
}
function mappedOf(rec: Rec, extra: Record<string, string> = {}): Record<string, string> {
  const o: Record<string, string> = {
    artists: [rec.artistName, ...rec.moreLeads.map(l => l.name)].filter(Boolean).join(' | '), artistId: rec.artistId, title: rec.title, version: rec.version, isrc: rec.isrc,
    album: rec.releaseTitle, releaseKey: rec.releaseId, trackKey: rec.trackId, label: rec.label, distributor: rec.distributor, language: rec.language, releaseDate: rec.releaseDate,
    credits: rec.credits.map(c => `${c.role}: ${c.name}`).join(' | '), ...extra,
  };
  for (const k of Object.keys(o)) if (!o[k]) delete o[k];
  return o;
}
const CREDIT_ROLE: Record<string, CreditRole> = { singer: 'Singer', vocals: 'Singer', vocalist: 'Singer', composer: 'Composer', 'music director': 'Composer', lyricist: 'Lyricist', 'lyric writer': 'Lyricist', producer: 'Producer', 'music producer': 'Producer', 'mixed by': 'Producer', 'mastered by': 'Producer', arranger: 'Producer', 'programmed by': 'Producer', performer: 'Performer', 'featured artist': 'Performer', rapper: 'Singer' };
const NOT_PEOPLE = new Set(['label', 'distributor', 'publisher', 'production house', 'copyright', 'record label']);
const isTestContent = (title: string, names: string[]) => /^(test|testing)\b/i.test(title) || /demoartist/i.test(names.join(' '));

/** Any catalogue export: columns are found by name, values normalized, several artists per cell split, nothing invented. */
function catalogueRecs(layout: Layout): Rec[] {
  const map = layout.map!;
  const ix = map.index;
  const width = map.header.length;
  const data = layout.table.slice(layout.headerRow + 1);
  const isML = layout.format === 'Media Library export';
  return data.map((cells, i): Rec => {
    const get = (f: Field) => (ix[f] === undefined ? '' : clean(cells[ix[f]!]));
    const raw: Record<string, string> = {};
    map.header.forEach((h, j) => { if (h) raw[h] = String(cells[j] ?? ''); });
    if (cells.length > width) raw['(extra cells)'] = cells.slice(width).join(' | ');
    const leads = splitArtists(get('artists'));
    const credits: CreditIn[] = [];
    let label = get('label');
    const add = (name: string, role: CreditRole) => { if (name && !credits.some(c => nameKey(c.name) === nameKey(name) && c.role === role)) credits.push({ id: null, name, role }); };
    for (const { role, names } of parseRoleCredits(ix.credits === undefined ? '' : cells[ix.credits])) {
      if (role === 'label' || role === 'record label') { label ||= names[0] ?? ''; continue; }
      if (NOT_PEOPLE.has(role)) continue;
      for (const n of names) add(n, CREDIT_ROLE[role] ?? normRole(role));
    }
    for (const n of splitArtists(get('composer'))) add(n, 'Composer');
    for (const n of splitArtists(get('lyricist'))) add(n, 'Lyricist');
    for (const n of splitArtists(get('producer'))) add(n, 'Producer');
    // Session musicians ("Bass: …") are collaborators on the song, not lead artists.
    for (const { names } of parseRoleCredits(ix.musicianCredits === undefined ? '' : cells[ix.musicianCredits])) for (const n of names) add(n, 'Other');
    const vocal = /vocal/i.test(get('vocalInstrumental'));
    const leadRole = (n: string): CreditRole => credits.find(c => nameKey(c.name) === nameKey(n) && (c.role === 'Singer' || c.role === 'Performer'))?.role ?? (!isML && vocal ? 'Singer' : 'Performer');
    const primary = leads[0] ?? '';
    const isrc = normIsrc(get('isrc'));
    const title = get('title');
    const album = get('album');
    const key = get('trackId') || (isrc ? `ISRC:${isrc}` : title && primary ? `SONG:${nameKey(title)}|${leads.map(nameKey).join('+')}|${nameKey(album)}` : '');
    const leadSet = new Set(leads.map((n, k) => `${nameKey(n)}|${leadRole(n)}|${k}`));
    const rec: Rec = {
      rowNumber: layout.headerRow + 2 + i, raw, mapped: {}, artistId: '', artistName: primary, artistRole: primary ? leadRole(primary) : 'Performer',
      moreLeads: leads.slice(1).map(n => ({ name: n, role: leadRole(n) })),
      trackId: key, releaseId: get('albumId') || get('upc') || (album ? `ALBUM:${nameKey(album)}|${nameKey(label)}` : ''), releaseTitle: album, title, version: get('version'), isrc, label,
      distributor: get('distributor'), language: (get('language').split(/[,;|]/)[0] ?? '').trim(), releaseDate: normDate(get('releaseDate') || get('goLiveDate')),
      // a lead artist's own singer/performer credit is the lead credit itself; their other roles (composer …) stay
      credits: credits.filter(c => ![...leadSet].some(s => s.startsWith(`${nameKey(c.name)}|${c.role}|`))), claimStatus: '', activity: '', profileUrl: '', provisional: true,
    };
    const extra: Record<string, string> = {};
    for (const f of ['upc', 'catalogNo', 'genre', 'goLiveDate', 'dateSubmitted', 'duration', 'contentType', 'vocalInstrumental', 'territory', 'godName', 'audioPath', 'publisher'] as Field[]) if (get(f)) extra[f] = get(f);
    if (get('artists') && leads.length > 1) extra.artistsRaw = get('artists');
    rec.mapped = mappedOf(rec, extra);
    if (cells.every(v => !clean(v))) rec.error = 'Empty row';
    else if (cells.length > width + 1 && cells.slice(width).some(v => clean(v))) rec.error = `Malformed row: ${cells.length} values for ${width} columns (check unquoted commas)`;
    else if (!title) rec.error = 'Missing song title';
    else if (!primary) rec.error = 'No artist named';
    else if (!key) rec.error = 'No song identifier (track ID or ISRC)';
    else if (isTestContent(title, [...leads, ...credits.map(c => c.name)])) rec.error = 'Test content: confirm with the backend team before use';
    return rec;
  });
}
function rowSig(r: Rec): string {
  return JSON.stringify([r.artistId, r.artistName, r.artistRole, r.moreLeads.length ? r.moreLeads : undefined, r.releaseId, r.title, r.version, r.isrc, r.label, r.distributor, r.language, r.releaseDate, r.credits, r.claimStatus, r.activity, r.profileUrl]);
}
function emptySummary(): ImportSummary {
  return {
    artistsCreated: 0, artistsUpdated: 0, newSongs: 0, updatedSongs: 0, newCredits: 0, reopenedCases: 0, newTasks: 0, newRoutes: 0, claimChanges: 0, activationChanges: 0,
    identityExceptions: 0, errors: [], warnings: [], classes: Object.fromEntries(IMPORT_CLASSES.map(c => [c, 0])) as Record<ImportClass, number>,
    newArtistIds: [], updatedArtistIds: [], reopenedCaseIds: [], taskIds: [], routeIds: [],
    artistsFound: 0, newCollaborators: 0, newCollaboratorIds: [], possibleDuplicates: 0, duplicateIds: [], reopenedArtistIds: [],
  };
}

export type StepFn = (step: (typeof IMPORT_STEPS)[number]) => Promise<void> | void;
export type ProgressFn = (done: number, total: number) => Promise<void> | void;

/** Lead artists named in a file, resolved to existing artists without changing anything (used for repeats too). */
function artistsInLayout(m: Model, layout: Layout | null): string[] {
  if (!layout) return [];
  const out: string[] = [];
  const addId = (id: string | undefined) => { if (id) { const cid = m.canonical(id); if (!out.includes(cid)) out.push(cid); } };
  if (layout.format === 'G Amplify standard') {
    const head = layout.table[0].map(h => clean(h).toLowerCase());
    const idCol = head.indexOf('artist_id'), nameCol = head.indexOf('artist_name');
    for (const row of layout.table.slice(1)) {
      const aid = idCol >= 0 ? clean(row[idCol]) : '';
      if (aid) addId(m.idx.caseByBackendId.get(aid));
      else if (nameCol >= 0) { const hits = m.casesNamed(clean(row[nameCol])); if (hits.length === 1) addId(hits[0].id); }
    }
    return out;
  }
  if (!layout.map) return out;
  const ix = layout.map.index;
  for (const row of layout.table.slice(layout.headerRow + 1)) {
    const isrc = ix.isrc === undefined ? '' : normIsrc(row[ix.isrc]);
    const tid = (ix.trackId !== undefined && clean(row[ix.trackId]) && m.idx.trackByBackendId.get(clean(row[ix.trackId]))) || (isrc && m.idx.trackByIsrc.get(isrc)) || null;
    for (const name of splitArtists(ix.artists === undefined ? '' : row[ix.artists])) {
      const cr = tid ? m.creditsOfTrack(tid).find(c => c.caseId && nameKey(c.personName) === nameKey(name)) : null;
      if (cr?.caseId) addId(cr.caseId);
      else { const hits = m.casesNamed(name); if (hits.length === 1) addId(hits[0].id); }
    }
  }
  return out;
}

export async function processImport(m: Model, ctx: Ctx, input: ImportInput, onStep: StepFn = () => {}, onProgress: ProgressFn = () => {}): Promise<ImportBatch> {
  requirePerm(m, ctx, 'import');
  await onStep('Uploading');
  const layout = detectLayout(input);
  const format = layout?.format ?? null;
  const batchId = m.nextId('B', 3);
  const summary = emptySummary();
  summary.encoding = input.encoding; summary.headerRow = layout ? layout.headerRow + 1 : undefined;
  if (layout?.map) { summary.mapping = layout.map.mapping.map(x => ({ field: x.field, column: x.column })); summary.unmappedColumns = layout.map.unmapped; }
  const base: ImportBatch = {
    id: batchId, originalFilename: input.filename, source: input.source || 'Goongoonalo backend export', format: format ?? 'G Amplify standard',
    exportDate: input.exportDate || ctx.today, uploadDate: ctx.now, uploaderId: ctx.userId, importType: input.importType ?? 'Incremental', checksum: input.checksum,
    version: 1, versionOfId: null, repeatOfId: null, rowCount: 0, acceptedCount: 0, quarantinedCount: 0, skippedCount: 0, status: 'Processed', summary, createdAt: ctx.now,
  };
  const rowCount = layout ? Math.max(0, layout.table.length - layout.headerRow - 1) : input.sheets ? input.sheets.reduce((n, s) => n + Math.max(0, s.rows.length - 1), 0) : Math.max(0, (input.table?.length ?? 1) - 1);
  // Repeat: the exact same file (checksum) was processed before. Nothing is changed.
  const prev = m.all('batches').find(b => b.checksum === input.checksum && b.status === 'Processed');
  if (prev) {
    summary.artistCaseIds = artistsInLayout(m, layout);
    summary.artistsFound = summary.artistCaseIds.length;
    const b = m.insert('batches', { ...base, status: 'Repeat', repeatOfId: prev.id, rowCount, skippedCount: rowCount });
    audit(m, ctx, { caseId: null, entity: 'ImportBatch', entityId: b.id, action: 'Repeat upload detected', reason: `Same checksum as ${prev.id}`, result: 'Existing batch retained. No duplicate work created.' });
    await onStep('Complete');
    return b;
  }
  if (!format || !layout) {
    summary.errors.push('Unknown file layout: no column for the song title and the artist was found. Use the Media Library export, a sheet with Track Name and Artist Name columns, the G Amplify standard CSV or the artist directory.');
    const b = m.insert('batches', { ...base, status: 'Failed', rowCount });
    audit(m, ctx, { caseId: null, entity: 'ImportBatch', entityId: b.id, action: 'Import failed', reason: summary.errors[0] });
    return b;
  }
  // Corrected file: same name as an earlier batch, different content -> new version, earlier evidence kept.
  const earlier = m.all('batches').filter(b => b.status === 'Processed' && (b.id === input.versionOfId || b.originalFilename === input.filename)).sort((a, b) => b.version - a.version || b.id.localeCompare(a.id))[0];
  if (earlier) { base.version = earlier.version + 1; base.versionOfId = earlier.id; }
  const batch = m.insert('batches', base);
  if (format === 'Artist directory') { await processDirectory(m, ctx, batch, input, layout, onStep); return m.get('batches', batch.id)!; }

  await onStep('Validating');
  const parsed = format === 'G Amplify standard' ? standardRecs(layout.table) : { recs: catalogueRecs(layout), missingColumns: [] };
  if (parsed.missingColumns.length) summary.errors.push(`Missing column(s): ${parsed.missingColumns.join(', ')}`);
  if (format !== 'G Amplify standard') {
    summary.warnings.push('This file has no artist IDs: artists are matched by song (ISRC), exact name and catalogue evidence, never by name alone, and marked provisional.');
    const has = (f: Field) => layout.map!.index[f] !== undefined;
    const missing = (['isrc', 'album', 'label', 'releaseDate'] as Field[]).filter(f => !has(f));
    if (missing.length) summary.warnings.push(`Optional column(s) not in this file: ${missing.join(', ')}. Those fields stay empty (nothing is guessed).`);
  }
  const rows: ImportRow[] = [];
  const newRow = (rec: Rec, status: ImportRow['status'], classification: ImportClass | null, reason: string | null, caseIds: string[] = [], trackId: string | null = null): ImportRow => {
    const row: ImportRow = { id: m.nextId('IR', 6), batchId: batch.id, rowNumber: rec.rowNumber, raw: rec.raw, mapped: rec.mapped, status, classification, reason, ownerId: status === 'Quarantined' ? ctx.userId : null, exceptionStatus: status === 'Quarantined' ? 'Open' : null, resolution: null, resolvedAt: null, caseIds, trackId };
    rows.push(row);
    return row;
  };

  await onStep('Matching');
  const seen = new Map<string, number>();         // track key → first row number in this file
  const seenIsrc = new Map<string, number>();     // ISRC → first row number in this file
  const changedTracks = new Set<string>(), newTracks = new Set<string>();
  // newSongs: songs where the artist is a lead (these reopen the artist); creditedOn: new songs where they are only credited.
  const touchedCases = new Map<string, { newSongs: string[]; newPeople: string[]; creditedOn: string[]; updated: boolean }>();
  const touch = (caseId: string, newSong?: string, newPerson?: string, creditedOn?: string) => {
    const x = touchedCases.get(caseId) ?? { newSongs: [], newPeople: [], creditedOn: [], updated: false };
    if (newSong) x.newSongs.push(newSong); else if (newPerson) { if (!x.newPeople.includes(newPerson)) x.newPeople.push(newPerson); } else if (creditedOn) x.creditedOn.push(creditedOn); else x.updated = true;
    touchedCases.set(caseId, x);
  };
  const createdCases = new Set<string>();
  const leadCases = new Set<string>();
  const exceptions: string[] = [];
  const byName = new Map<string, string>();       // name decided once per file (unambiguous names only)

  type Person = { id: string | null; name: string; role: CreditRole; primary: boolean };
  const resolvePerson = (p: Person, rec: Rec, existingTrack: Track | null): { caseId: string | null; created: boolean; exception: boolean } => {
    const { id, name } = p;
    if (id) {
      const existing = m.idx.caseByBackendId.get(id);
      if (existing) {
        const c = m.get('cases', m.canonical(existing))!;
        if (![c.canonicalName, ...c.aliases].some(n => nameKey(n) === nameKey(name))) {
          m.update('cases', c.id, { aliases: [...c.aliases, name] });
          audit(m, ctx, { caseId: c.id, entity: 'ArtistCase', entityId: c.id, action: 'Alias added from import', field: 'aliases', to: name, reason: `${batch.id} row ${rec.rowNumber} uses ${id} with this spelling` });
          touch(c.id);
        }
        return { caseId: c.id, created: false, exception: false };
      }
      const same = m.casesNamed(name), similar = m.casesSimilar(name).filter(x => !same.includes(x));
      const c = newCaseRecord(m, { ...ctx }, { name, backendId: id, batchId: batch.id, language: rec.language || null, profileUrl: id === rec.artistId ? rec.profileUrl || null : null, kind: 'Artist' });
      createdCases.add(c.id);
      audit(m, ctx, { caseId: c.id, entity: 'ArtistCase', entityId: c.id, action: 'Case created from import', to: `${name} (${id})`, reason: `${batch.id} row ${rec.rowNumber}: “${rec.title}”` });
      const clash = same.length ? same : similar;
      if (clash.length) {
        const conflict = openDuplicate(m, ctx, c, clash, same.length ? 'Same name' : 'Similar spelling', `${name} (${id}) in ${batch.id} has the same or a similar name as ${clash.map(x => `${x.canonicalName} (${x.backendProfileIds.join(', ') || x.id})`).join(', ')}. Name similarity alone never merges cases.`);
        if (conflict) {
          setStage(m, ctx, c, 'Identity Review', `Possible duplicate (${conflict.id}). A reviewer decides before any contact.`);
          m.update('cases', c.id, { identityStatus: 'Under Review' });
          exceptions.push(conflict.id);
          return { caseId: c.id, created: true, exception: true };
        }
      }
      return { caseId: c.id, created: true, exception: false };
    }
    // Same song already known: its credit for this name tells which artist it is (same-name artists stay apart).
    if (existingTrack) {
      const cr = m.creditsOfTrack(existingTrack.id).find(x => x.caseId && nameKey(x.personName) === nameKey(name));
      if (cr?.caseId) return { caseId: m.canonical(cr.caseId), created: false, exception: false };
    }
    const known = byName.get(nameKey(name));
    if (known) return { caseId: known, created: false, exception: false };
    const matches = m.casesNamed(name).filter(c => !c.rejectedAt);
    if (matches.length === 1) { byName.set(nameKey(name), matches[0].id); return { caseId: matches[0].id, created: false, exception: false }; }
    if (matches.length > 1) {
      // Several artists share this name: only catalogue evidence (label, collaborators, language) may pick one.
      const names = new Set([rec.artistName, ...rec.moreLeads.map(l => l.name), ...rec.credits.map(c => c.name)].map(nameKey));
      const scored = matches.map(c => {
        let s = 0;
        const tracks = m.trackIdsOfCase(c.id).map(t => m.get('tracks', t)!).filter(Boolean);
        if (rec.label && tracks.some(t => t.label === rec.label)) s += 2;
        if (tracks.some(t => m.creditsOfTrack(t.id).some(cr => cr.caseId !== c.id && names.has(nameKey(cr.personName))))) s += 2;
        if (rec.language && c.language === rec.language) s += 1;
        return { c, s };
      }).sort((a, b) => b.s - a.s);
      if (scored[0].s > 0 && scored[0].s > (scored[1]?.s ?? 0)) return { caseId: scored[0].c.id, created: false, exception: false };
      const key = matches.map(x => x.id).sort().join(',');
      if (!m.all('conflicts').some(x => x.status !== 'Decided' && x.caseIds.slice().sort().join(',') === key)) {
        const conflict = m.insert('conflicts', { id: m.nextId('IC', 4), caseIds: matches.map(x => x.id), kind: 'Import exception', reason: `A credit for “${name}” without an artist ID in ${batch.id} matches ${matches.length} artists and nothing in the row tells them apart. The credit stays unlinked until a reviewer decides.`, status: 'Open', createdAt: ctx.now, createdBy: ctx.userId, decisionId: null });
        exceptions.push(conflict.id);
      }
      return { caseId: null, created: false, exception: true };
    }
    const c = newCaseRecord(m, ctx, { name, backendId: null, batchId: batch.id, identityStatus: 'Provisional', language: rec.language || null, kind: p.primary ? 'Artist' : 'Collaborator' });
    createdCases.add(c.id);
    byName.set(nameKey(name), c.id);
    audit(m, ctx, { caseId: c.id, entity: 'ArtistCase', entityId: c.id, action: 'Case created from import', to: `${name} (provisional, no artist ID)`, reason: `${batch.id} row ${rec.rowNumber}: “${rec.title}”` });
    return { caseId: c.id, created: true, exception: false };
  };

  await onStep('Detecting changes');
  const claimRows: { rec: Rec; caseId: string; row: ImportRow }[] = [];
  const total = parsed.recs.length;
  let done = 0;
  for (const rec of parsed.recs) {
    if (++done % 500 === 0) await onProgress(done, total);
    if (rec.error) { newRow(rec, rec.error === 'Empty row' ? 'Skipped' : 'Quarantined', null, rec.error); continue; }
    const firstRow = seen.get(rec.trackId);
    if (firstRow !== undefined) { newRow(rec, 'Skipped', 'Unchanged', `Same song appears twice in this file (row ${firstRow})`); continue; }
    if (rec.isrc && seenIsrc.has(rec.isrc)) { newRow(rec, 'Skipped', 'Unchanged', `Same recording (ISRC ${rec.isrc}) as row ${seenIsrc.get(rec.isrc)}: one song, not a duplicate`); continue; }
    seen.set(rec.trackId, rec.rowNumber);
    if (rec.isrc) seenIsrc.set(rec.isrc, rec.rowNumber);
    const sig = rowSig(rec);
    // Known song: by its ID, or by ISRC when the file has no stable song ID.
    let existingId = m.idx.trackByBackendId.get(rec.trackId);
    if (!existingId && rec.isrc && format !== 'G Amplify standard') existingId = m.idx.trackByIsrc.get(rec.isrc);
    const existing = existingId ? m.get('tracks', existingId)! : null;
    if (existing && existing.sig === sig) {
      // Nothing meaningful changed: only last-seen information is updated, no task is created.
      m.update('tracks', existing.id, { lastSeen: ctx.now, lastBatchId: batch.id });
      const primaries = m.creditsOfTrack(existing.id).filter(cr => cr.isPrimary && cr.caseId && cr.status === 'Active').map(cr => m.canonical(cr.caseId!));
      const known = primaries.length ? primaries : rec.artistId && m.idx.caseByBackendId.get(rec.artistId) ? [m.canonical(m.idx.caseByBackendId.get(rec.artistId)!)] : [];
      for (const id of known) { leadCases.add(id); if (m.get('cases', id)!.lastSeenBatchId !== batch.id) m.update('cases', id, { lastSeen: ctx.now, lastSeenBatchId: batch.id }); }
      newRow(rec, 'Skipped', 'Unchanged', 'Already imported, nothing changed', known, existing.id);
      continue;
    }
    if (existing && existing.isrc && rec.isrc && existing.isrc !== rec.isrc) {
      newRow(rec, 'Quarantined', 'Identity Exception', `Conflicting identifiers: ISRC ${rec.isrc} differs from stored ${existing.isrc} for track ${rec.trackId}`, [], existing.id);
      continue;
    }
    let cls: ImportClass | null = null;
    const upgrade = (c: ImportClass) => { const order: ImportClass[] = ['Identity Exception', 'New Artist', 'New Relationship', 'Updated Metadata', 'Claim State Change', 'Activation State Change']; if (!cls || order.indexOf(c) < order.indexOf(cls)) cls = c; };
    const caseIds: string[] = [];
    const persons: Person[] = [
      { id: rec.artistId || null, name: rec.artistName, role: rec.artistRole, primary: true },
      ...rec.moreLeads.map(l => ({ id: null, name: l.name, role: l.role, primary: true })),
      ...rec.credits.map(c => ({ ...c, primary: false })),
    ];
    const resolved = persons.map(p => ({ ...p, ...resolvePerson(p, rec, existing) }));
    for (const r of resolved) {
      if (r.created) upgrade(r.exception ? 'Identity Exception' : 'New Artist'); else if (r.exception) upgrade('Identity Exception');
      if (r.caseId && !caseIds.includes(r.caseId)) caseIds.push(r.caseId);
      if (r.primary && r.caseId) leadCases.add(m.canonical(r.caseId));
    }
    let track: Track;
    let changed = !existing;
    if (!existing) {
      let releaseId: string | null = null;
      if (rec.releaseId) {
        releaseId = m.idx.releaseByBackendId.get(rec.releaseId) ?? null;
        if (!releaseId) releaseId = m.insert('releases', { id: m.nextId('RL', 5), backendReleaseId: rec.releaseId, title: rec.releaseTitle || rec.title, firstSeen: ctx.now }).id;
      }
      const flags: string[] = [];
      if (rec.isrc && !ISRC_RE.test(rec.isrc)) flags.push('ISRC format invalid');
      if (!rec.isrc) flags.push('ISRC missing');
      if (!rec.label) flags.push('Label missing');
      if (!rec.distributor) flags.push('Distributor missing');
      track = m.insert('tracks', {
        id: m.nextId('TR', 6), backendTrackId: rec.trackId, releaseId, title: rec.title, version: rec.version, isrc: rec.isrc, label: rec.label, distributor: rec.distributor,
        language: rec.language, releaseDate: rec.releaseDate, source: batch.format, flags, sig, firstSeen: ctx.now, lastSeen: ctx.now, firstBatchId: batch.id, lastBatchId: batch.id, history: [],
      });
      summary.newSongs++;
      newTracks.add(track.id); changedTracks.add(track.id);
      upgrade('New Relationship');
    } else {
      track = existing;
      const fields: [keyof Track, string][] = [['title', rec.title], ['version', rec.version], ['isrc', rec.isrc], ['label', rec.label], ['distributor', rec.distributor], ['language', rec.language], ['releaseDate', rec.releaseDate]];
      const history = [...track.history];
      const patch: Partial<Track> = { sig, lastSeen: ctx.now, lastBatchId: batch.id };
      for (const [f, v] of fields) if (v && String(track[f] ?? '') !== v) { history.push({ at: ctx.now, batchId: batch.id, field: String(f), from: String(track[f] ?? ''), to: v }); (patch as Record<string, unknown>)[f] = v; }
      if (history.length > track.history.length) { patch.history = history; summary.updatedSongs++; upgrade('Updated Metadata'); changedTracks.add(track.id); changed = true; }
      m.update('tracks', track.id, patch);
    }
    // Credits: a song can credit several people, and a person can hold several roles on it.
    const active = m.creditsOfTrack(track.id).filter(c => c.status === 'Active');
    const keep = new Set<string>();
    const leadsOfTrack = () => [...new Set(m.creditsOfTrack(track.id).filter(c => c.isPrimary && c.caseId && c.status === 'Active').map(c => m.canonical(c.caseId!)))];
    for (const r of resolved) {
      const match = active.find(c => c.role === r.role && (r.caseId ? c.caseId && m.canonical(c.caseId) === m.canonical(r.caseId) : !c.caseId && nameKey(c.personName) === nameKey(r.name)));
      if (match) {
        keep.add(match.id);
        const patch: Partial<typeof match> = {};
        if (match.lastSeen !== ctx.now) patch.lastSeen = ctx.now;
        if (r.primary && !match.isPrimary) { patch.isPrimary = true; changed = true; }   // a later file names them as lead artist
        if (Object.keys(patch).length) m.update('credits', match.id, patch);
        continue;
      }
      const cr = m.insert('credits', { id: m.nextId('CR', 6), trackId: track.id, caseId: r.caseId, personName: r.name, personBackendId: r.id, role: r.role, isPrimary: r.primary, source: batch.format, sourceVersion: batch.id, firstSeen: ctx.now, lastSeen: ctx.now, status: 'Active', statusReason: null });
      keep.add(cr.id);
      summary.newCredits++;
      changedTracks.add(track.id);
      changed = true;
      if (existing) upgrade('New Relationship');
      if (r.caseId) { if (!existing) touch(m.canonical(r.caseId), r.primary ? track.title : undefined, undefined, r.primary ? undefined : track.title); else touch(m.canonical(r.caseId)); }
      // A new person on a song the artist already had: the artist's record gets a new collaborator.
      if (existing && !r.primary) for (const lead of leadsOfTrack()) if (!r.caseId || lead !== m.canonical(r.caseId)) touch(lead, undefined, `${r.name} (${r.role.toLowerCase()}) on “${track.title}”`);
    }
    // A new song can also bring someone the artist never worked with before: listed as a new collaborator too.
    if (!existing) for (const r of resolved) {
      if (r.primary) continue;
      const who = r.caseId ? m.canonical(r.caseId) : null;
      for (const lead of leadsOfTrack()) {
        if (who === lead) continue;
        const before = m.creditsOfCase(lead).some(cl => cl.trackId !== track.id && m.creditsOfTrack(cl.trackId).some(o => o.trackId !== track.id && (who ? o.caseId && m.canonical(o.caseId) === who : nameKey(o.personName) === nameKey(r.name))));
        if (!before) touch(lead, undefined, `${r.name} (${r.role.toLowerCase()}) on “${track.title}”`);
      }
    }
    if (existing && (batch.versionOfId || batch.importType === 'Full')) {
      for (const c of active) if (!keep.has(c.id)) { m.update('credits', c.id, { status: 'Superseded', statusReason: `Not in ${batch.versionOfId ? `corrected file ${batch.id} (v${batch.version})` : `full export ${batch.id}`}` }); changed = true; }
    }
    // Same song known from another file (or layout) and nothing new in this row: counted as unchanged, not as work.
    if (!changed && !rec.claimStatus && !rec.activity) {
      for (const id of caseIds) if (m.get('cases', id)!.lastSeenBatchId !== batch.id) m.update('cases', id, { lastSeen: ctx.now, lastSeenBatchId: batch.id });
      newRow(rec, 'Skipped', 'Unchanged', 'Already known (same song), nothing new', caseIds, track.id);
      continue;
    }
    const row = newRow(rec, 'Accepted', cls, null, caseIds, track.id);
    for (const id of caseIds) m.update('cases', id, { lastSeen: ctx.now, lastSeenBatchId: batch.id, ...(rec.language && !m.get('cases', id)!.language ? { language: rec.language } : {}) });
    const primaryCase = resolved[0].caseId;
    if (primaryCase && (rec.claimStatus || rec.activity)) claimRows.push({ rec, caseId: m.canonical(primaryCase), row });
  }
  await onProgress(total, total);
  // Rows never touch history: unchanged tracks keep their credits; tracks absent from a full export are flagged, not deleted.
  if (batch.importType === 'Full') {
    let absent = 0;
    for (const t of m.all('tracks')) if (!seen.has(t.backendTrackId) && t.source === batch.format && !t.flags.includes(`Absent from full export ${batch.id}`)) { m.update('tracks', t.id, { flags: [...t.flags, `Absent from full export ${batch.id}`] }); absent++; }
    if (absent) summary.warnings.push(`${absent} known song(s) were not in this full export. They are flagged, not deleted, and no claim is assumed revoked.`);
  }

  await onStep('Updating cases');
  for (const { rec, caseId, row } of claimRows) {
    const c = m.get('cases', caseId)!;
    if (rec.claimStatus === 'claimed' && c.claimStatus !== 'Completed') {
      summary.claimChanges++;
      if (!row.classification) row.classification = 'Claim State Change';
      if (c.claimStatus === 'Approved') {
        const sub = m.familyItems('claimEvents', c.id).filter(e => e.type === 'Submitted').pop();
        const e = m.insert('claimEvents', { id: m.nextId('CE', 4), caseId: c.id, type: 'Backend Verified', date: ctx.now, profileId: rec.artistId || sub?.profileId || null, claimRequestId: sub?.claimRequestId ?? null, recipient: sub?.recipient ?? c.canonicalName, reviewerId: null, notes: `Reported by ${batch.id}`, evidence: `${batch.id} row ${rec.rowNumber}: claim_status=claimed`, actorId: ctx.userId, source: 'Import' });
        m.update('cases', c.id, { claimStatus: 'Completed' });
        audit(m, ctx, { caseId: c.id, entity: 'ClaimEvent', entityId: e.id, action: 'Backend claim verified by import', field: 'claimStatus', from: 'Approved', to: 'Completed', evidence: e.evidence });
        setStage(m, ctx, c, 'Claimed', `Backend export ${batch.id} reports the profile claimed`, e.evidence);
      } else {
        const e = m.insert('claimEvents', { id: m.nextId('CE', 4), caseId: c.id, type: 'Backend Reported Claimed', date: ctx.now, profileId: rec.artistId || null, claimRequestId: null, recipient: null, reviewerId: null, notes: `Backend says claimed while the case shows ${c.claimStatus}. Review before counting it.`, evidence: `${batch.id} row ${rec.rowNumber}`, actorId: ctx.userId, source: 'Import' });
        audit(m, ctx, { caseId: c.id, entity: 'ClaimEvent', entityId: e.id, action: 'Claim state change detected', reason: e.notes, evidence: e.evidence });
        notify(m, ctx, 'Claim submitted', `${c.canonicalName}: backend reports the profile claimed (case shows ${c.claimStatus}). Review it.`, c.id);
      }
    }
    if (rec.activity) {
      const [kind, ref, date] = rec.activity.split('|').map(x => x.trim());
      const already = m.familyItems('activationEvents', c.id).some(e => e.backendRef === ref && ref);
      if (!already) {
        summary.activationChanges++;
        if (!row.classification) row.classification = 'Activation State Change';
        const login = /login/i.test(kind ?? '');
        const meaningful = !login && ['Access Verified', 'Feature Selected'].includes(c.activationStatus) && c.lifecycleStage === 'Activation Pending';
        const e = m.insert('activationEvents', { id: m.nextId('AE', 4), caseId: c.id, type: login ? 'Login Only' : meaningful ? 'Meaningful Use' : 'Backend Activity', date: date ? `${date}T00:00:00.000Z` : ctx.now, feature: login ? null : kind ?? null, expectedOutcome: null, operatorId: null, agreedDate: null, backendRef: ref || null, evidence: `${batch.id} row ${rec.rowNumber}: ${rec.activity}`, result: meaningful ? 'Verified' : login ? 'Access only' : 'Recorded', actorId: ctx.userId });
        audit(m, ctx, { caseId: c.id, entity: 'ActivationEvent', entityId: e.id, action: 'Backend activity received', to: rec.activity, result: e.result });
        if (meaningful) {
          m.update('cases', c.id, { activationStatus: 'Activated' });
          setStage(m, ctx, c, 'Activated', `Backend event ${ref} (${kind}) shows meaningful use`, ref);
        }
      }
    }
  }
  // Artist or collaborator: decided by the credits now on file (a collaborator named as lead artist becomes an artist).
  for (const id of new Set([...createdCases, ...touchedCases.keys()])) {
    const c = m.get('cases', id);
    if (!c || c.mergedIntoId) continue;
    const k = kindOf(m, c);
    if (k !== c.kind) {
      m.update('cases', c.id, { kind: k });
      if (!createdCases.has(id)) audit(m, ctx, { caseId: c.id, entity: 'ArtistCase', entityId: c.id, action: 'Artist type changed', field: 'kind', from: c.kind, to: k, reason: `${batch.id}: now credited as a lead or performing artist` });
    }
  }
  for (const [caseId, info] of touchedCases) {
    const c = m.get('cases', caseId);
    if (!c) continue;
    if (!createdCases.has(caseId)) summary.updatedArtistIds.push(caseId);
    if (info.newSongs.length) evidenceChanged(m, ctx, c, `${info.newSongs.length} new song(s) in ${batch.id}: ${info.newSongs.slice(0, 3).map(t => `“${t}”`).join(', ')}${info.newSongs.length > 3 ? '…' : ''}`);
    else if (info.newPeople.length) evidenceChanged(m, ctx, c, `New collaborator(s) in ${batch.id}: ${info.newPeople.slice(0, 2).join('; ')}`);
    else if (info.creditedOn.length) evidenceChanged(m, ctx, c, `Credited on ${info.creditedOn.length} new song(s) in ${batch.id}: ${info.creditedOn.slice(0, 3).map(t => `“${t}”`).join(', ')}${info.creditedOn.length > 3 ? '…' : ''}`);
    else if (info.updated && !createdCases.has(caseId)) evidenceChanged(m, ctx, c, `Credits or metadata changed in ${batch.id}`);
  }
  const created = [...createdCases].map(id => m.get('cases', id)!).filter(Boolean);
  summary.newArtistIds = created.filter(c => c.kind === 'Artist').map(c => c.id);
  summary.newCollaboratorIds = created.filter(c => c.kind === 'Collaborator').map(c => c.id);
  summary.artistsCreated = summary.newArtistIds.length;
  summary.newCollaborators = summary.newCollaboratorIds.length;
  summary.artistsUpdated = summary.updatedArtistIds.length;
  summary.artistsFound = leadCases.size;

  // Possible duplicates among the people this file created (same name elsewhere, similar spelling, "… Official").
  const inReview = new Set(m.all('conflicts').flatMap(x => x.caseIds));
  const dups = scanDuplicates(m, ctx, [...createdCases].filter(id => !inReview.has(id)));
  summary.duplicateIds = [...new Set([...exceptions.filter(id => m.get('conflicts', id)?.kind !== 'Import exception'), ...dups.map(d => d.id)])];
  summary.possibleDuplicates = summary.duplicateIds.length;
  summary.identityExceptions = exceptions.length + dups.length;

  // Evidence graph: songs, credits, labels and distributors that changed in this file
  for (const tid of changedTracks) syncTrackGraph(m, ctx, tid);

  await onStep('Creating tasks');
  // The very first load of a catalogue only builds the dossiers; leads are evaluated on every later import.
  const out = m.all('batches').some(b => b.status === 'Processed' && b.id !== batch.id) ? applyLeads(m, ctx, leadsForTracks(m, changedTracks), { label: `Batch ${batch.id}`, batchId: batch.id, newTracks }, emptyOutcome()) : emptyOutcome();
  summary.reopenedCaseIds = out.reopenedCaseIds; summary.reopenedCases = out.reopenedCaseIds.length;
  summary.taskIds = out.taskIds; summary.newTasks = out.taskIds.length;
  summary.routeIds = out.routeIds; summary.newRoutes = out.routeIds.length;
  // New evidence for artists a person already worked on reopens them (verification and history are kept).
  for (const [caseId, info] of touchedCases) {
    if (createdCases.has(caseId)) continue;
    // Every reason is listed: new songs and new collaborators each get their own line.
    const bySongs = info.newSongs.length > 0 && reopenArtist(m, ctx, caseId, 'new_song', `${info.newSongs.length} new song${info.newSongs.length === 1 ? '' : 's'} in ${batch.id}: ${info.newSongs.slice(0, 3).map(t => `“${t}”`).join(', ')}${info.newSongs.length > 3 ? '…' : ''}`);
    const byPeople = info.newPeople.length > 0 && reopenArtist(m, ctx, caseId, 'new_collaborator', `New collaborator${info.newPeople.length === 1 ? '' : 's'} in ${batch.id}: ${info.newPeople.slice(0, 3).join('; ')}${info.newPeople.length > 3 ? '…' : ''}`);
    const ok = bySongs || byPeople;
    if (ok) summary.reopenedArtistIds!.push(caseId);
  }
  for (const id of out.reopenedCaseIds) if (!summary.reopenedArtistIds!.includes(id) && m.get('cases', id)?.reopen) summary.reopenedArtistIds!.push(id);
  if (out.suppressedCaseIds.length) summary.warnings.push(`${out.suppressedCaseIds.length} case(s) got new evidence but are Do Not Contact / Declined: no outreach created.`);
  for (const id of out.routeIds) syncRouteGraph(m, ctx, id);
  // Targeted discovery: artists already searched or verified get a small search around the new evidence only.
  summary.targetedJobIds = [];
  if (!searchBlocked(m, ctx) && !ctx.searchBudget?.exhausted) for (const [caseId, info] of touchedCases) {
    if (createdCases.has(caseId) || !info.newSongs.length) continue;
    const c = m.get('cases', caseId);
    if (!c || c.mergedIntoId || c.discoveryStatus === 'Not started') continue;
    const jobs = m.byCase('discoveryJobs', caseId);
    if (jobs.some(j => j.status === 'QUEUED' || j.status === 'SEARCHING' || j.status === 'PROCESSING') || !jobs.some(j => j.status === 'COMPLETED' || j.status === 'NEEDS_REVIEW') && c.verifiedProfileCount === 0) continue;
    const newTrackIds = m.trackIdsOfCase(caseId).filter(id => newTracks.has(id));
    if (!newTrackIds.length) continue;
    const job = queueJob(m, ctx, { caseId, mode: 'targeted', trigger: `Batch ${batch.id}: ${info.newSongs.length} new song${info.newSongs.length === 1 ? '' : 's'}`, requestedBy: ctx.userId, focusTrackIds: newTrackIds, focus: info.newSongs.slice(0, 5).map(t => `New song “${t}”`) });
    summary.targetedJobIds.push(job.id);
    audit(m, ctx, { caseId, entity: 'DiscoveryJob', entityId: job.id, action: 'Targeted discovery queued', reason: `New evidence in ${batch.id}: ${info.newSongs.slice(0, 3).map(t => `“${t}”`).join(', ')}`, result: 'Searches only around the new songs and collaborators; earlier evidence is kept' });
  }
  const routeTracks = new Set(out.routeIds.map(id => m.get('routes', id)?.trackId).filter(Boolean) as string[]);
  for (const row of rows) if (row.status === 'Accepted' && row.trackId && routeTracks.has(row.trackId)) row.classification = 'New Evidence (route)';
  for (const row of rows) { if (row.status === 'Accepted' && !row.classification) row.classification = 'Updated Metadata'; m.insert('importRows', row); }
  for (const row of rows) if (row.status === 'Accepted' && row.classification) summary.classes[row.classification]++; else if (row.status === 'Skipped') summary.classes.Unchanged++;
  summary.artistCaseIds = [...leadCases];
  const touchedIds = new Set([...touchedCases.keys(), ...createdCases]);
  for (const id of touchedIds) { const c = m.get('cases', id); if (c) { computePriority(m, c, ctx.today); syncNextAction(m, id); } }
  syncArtistStatuses(m, ctx, touchedIds);
  const counts = { rowCount: parsed.recs.length, acceptedCount: rows.filter(r => r.status === 'Accepted').length, quarantinedCount: rows.filter(r => r.status === 'Quarantined').length, skippedCount: rows.filter(r => r.status === 'Skipped').length };
  summary.errors.push(...(counts.quarantinedCount ? [`${counts.quarantinedCount} row(s) need review: see the Review tab (row number, original values and reason).`] : []));
  m.update('batches', batch.id, { ...counts, summary });
  audit(m, ctx, { caseId: null, entity: 'ImportBatch', entityId: batch.id, action: 'Batch processed', to: `${counts.rowCount} rows = ${counts.acceptedCount} accepted + ${counts.quarantinedCount} to review + ${counts.skippedCount} skipped`, result: `${summary.artistsFound} artists found · ${summary.artistsCreated} new artists · ${summary.newCollaborators} new collaborators · ${summary.newSongs} new songs · ${summary.possibleDuplicates} possible duplicates · ${summary.reopenedArtistIds!.length} reopened`, reason: batch.versionOfId ? `Version ${batch.version} of ${batch.versionOfId}` : null });
  if (summary.possibleDuplicates) notify(m, ctx, 'Identity conflict', `${batch.id}: ${summary.possibleDuplicates} possible duplicate(s) to review in Deduplicate.`, null);
  notify(m, ctx, 'Import', `${batch.id} processed: ${counts.acceptedCount} accepted, ${counts.quarantinedCount} to review, ${counts.skippedCount} skipped · ${summary.artistsCreated} new artists${summary.reopenedArtistIds!.length ? `, ${summary.reopenedArtistIds!.length} reopened` : ''}.`, null);
  await onStep('Complete');
  return m.get('batches', batch.id)!;
}

async function processDirectory(m: Model, ctx: Ctx, batch: ImportBatch, input: ImportInput, layout: Layout, onStep: StepFn) {
  const summary = batch.summary;
  await onStep('Validating');
  const entries: { row: number; sheet: string; raw: Record<string, string>; name: string; link: string; conf: number | null; basis: string }[] = [];
  const sheets = input.sheets ?? [{ name: 'csv', rows: layout.table }];
  for (const sh of sheets) {
    const rows = sh.rows;
    const hi = rows.slice(0, 12).findIndex(r => (r ?? []).some(v => clean(v).toLowerCase() === 'artist name'));
    if (hi < 0) continue;
    const head = (rows[hi] ?? []).map(v => clean(v).toLowerCase());
    for (let i = hi + 1; i < rows.length; i++) {
      const r = rows[i] ?? [];
      const raw: Record<string, string> = {};
      head.forEach((h, j) => { if (h) raw[h] = clean(r[j]); });
      if (!raw['artist name']) continue;
      const conf = raw['confidence %'] ? Number(raw['confidence %']) : null;
      entries.push({ row: i + 1, sheet: sh.name, raw, name: raw['artist name'], link: raw['social link'] ?? '', conf: Number.isFinite(conf) ? conf : null, basis: raw['link basis'] ?? '' });
    }
  }
  await onStep('Matching');
  let accepted = 0, skipped = 0;
  const created = new Set<string>();
  await onStep('Detecting changes');
  for (const e of entries) {
    let c: ArtistCase | undefined = m.casesNamed(e.name)[0];
    const isUrl = /^https?:\/\//i.test(e.link);
    if (!c) {
      c = newCaseRecord(m, ctx, { name: e.name, backendId: null, batchId: batch.id, identityStatus: 'Provisional' });
      created.add(c.id);
      audit(m, ctx, { caseId: c.id, entity: 'ArtistCase', entityId: c.id, action: 'Case created from directory', reason: `${batch.id} ${e.sheet} row ${e.row}` });
    }
    let cls: ImportClass = created.has(c.id) ? 'New Artist' : 'Unchanged';
    if (isUrl && !c.profileUrls.includes(e.link)) {
      m.update('cases', c.id, { profileUrls: [...c.profileUrls, e.link] });
      if (!m.byCase('routes', c.id).some(r => r.sourceUrl === e.link)) {
        const strong = (e.conf ?? 0) >= 85;
        const routeRow = m.insert('routes', { id: m.nextId('RT', 4), targetCaseId: c.id, trackId: null, collaboratorName: null, collaboratorCaseId: null, organisation: null, contactId: null, sourceUrl: e.link, evidence: `Directory research: ${e.basis || 'profile found'} (${e.conf ?? '?'}% match)`, confidence: e.conf ?? 50, state: strong ? 'Verified' : 'Candidate', ranking: 4, lastChecked: ctx.now, rejectionReason: null, ownerId: c.ownerId, origin: `Directory ${batch.id}`, path: null, pathId: null, createdAt: ctx.now });
        syncRouteGraph(m, ctx, routeRow.id);
        summary.newRoutes++;
      }
      cls = created.has(c.id) ? 'New Artist' : 'New Evidence (route)';
    }
    if (/deceased/i.test(e.link) && c.lifecycleStage !== 'Closed') { m.update('cases', c.id, { closedReason: 'Deceased or historical figure (directory research)' }); setStage(m, ctx, c, 'Closed', 'Directory research: deceased or historical figure'); cls = 'Updated Metadata'; }
    const status: ImportRow['status'] = cls === 'Unchanged' ? 'Skipped' : 'Accepted';
    if (status === 'Accepted') accepted++; else skipped++;
    summary.classes[cls]++;
    m.insert('importRows', { id: m.nextId('IR', 6), batchId: batch.id, rowNumber: e.row, raw: e.raw, mapped: { artists: e.name, profileUrl: e.link }, status, classification: cls, reason: status === 'Skipped' ? 'Nothing new for this artist' : null, ownerId: null, exceptionStatus: null, resolution: null, resolvedAt: null, caseIds: [c.id], trackId: null });
  }
  await onStep('Updating cases');
  summary.newArtistIds = [...created];
  summary.artistsCreated = created.size;
  summary.artistsFound = entries.length;
  await onStep('Creating tasks');
  m.update('batches', batch.id, { rowCount: entries.length, acceptedCount: accepted, skippedCount: skipped, quarantinedCount: 0, summary });
  syncArtistStatuses(m, ctx, created);
  audit(m, ctx, { caseId: null, entity: 'ImportBatch', entityId: batch.id, action: 'Directory processed', to: `${entries.length} rows`, result: `${summary.newRoutes} profile routes · ${created.size} new artists` });
  notify(m, ctx, 'Import', `${batch.id} directory processed: ${summary.newRoutes} profile links added as routes.`, null);
  await onStep('Complete');
}
