import { Staff, WorkSite } from '../types';

export interface ParseError {
  row: number;
  message: string;
}

export interface StaffParseResult {
  valid: Staff[];
  errors: ParseError[];
}

export interface SiteParseResult {
  valid: WorkSite[];
  errors: ParseError[];
}

const VALID_WEEKDAYS = new Set(['月', '火', '水', '木', '金', '土', '日']);

// RFC 4180 準拠の簡易CSVパーサー
function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuote = !inQuote;
      }
    } else if (ch === ',' && !inQuote) {
      fields.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

function stripBom(text: string): string {
  return text.startsWith('﻿') ? text.slice(1) : text;
}

function isValidDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  return !isNaN(new Date(s + 'T00:00:00').getTime());
}

function isValidTime(s: string): boolean {
  return /^\d{2}:\d{2}$/.test(s);
}

// requestedDaysOff の正規化：YYYY/MM/DD → YYYY-MM-DD、M/D → refYear補完
// refYear を省略すると当年を使用。変換不能な場合は null を返す
function normalizeDayOffDate(raw: string, refYear?: number): string | null {
  const s = raw.trim();
  if (!s) return null;

  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return isValidDate(s) ? s : null;
  }

  const mFull = s.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if (mFull) {
    const n = `${mFull[1]}-${mFull[2].padStart(2, '0')}-${mFull[3].padStart(2, '0')}`;
    return isValidDate(n) ? n : null;
  }

  const mShort = s.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (mShort) {
    const year = refYear ?? new Date().getFullYear();
    const n = `${year}-${mShort[1].padStart(2, '0')}-${mShort[2].padStart(2, '0')}`;
    return isValidDate(n) ? n : null;
  }

  return null;
}

// ── スタッフCSV ──────────────────────────────────────────

export function parseStaffCSV(rawText: string): StaffParseResult {
  const lines = stripBom(rawText)
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '');

  const valid: Staff[] = [];
  const errors: ParseError[] = [];

  // ヘッダー行をスキップ
  const start = lines[0]?.toLowerCase().startsWith('name') ? 1 : 0;

  for (let i = start; i < lines.length; i++) {
    const rowNum = i + 1;
    const fields = parseCSVLine(lines[i]);

    if (fields.length < 4) {
      errors.push({ row: rowNum, message: `列数不足（${fields.length}列）` });
      continue;
    }

    const [nameRaw, weekdaysRaw, daysOffRaw, maxDaysRaw, memoRaw = ''] = fields;
    const name = nameRaw.trim();

    if (!name) {
      errors.push({ row: rowNum, message: '名前が空です' });
      continue;
    }

    const availableWeekdays = weekdaysRaw
      .split(',')
      .map((w) => w.trim())
      .filter((w) => w !== '');

    const invalidWeekdays = availableWeekdays.filter((w) => !VALID_WEEKDAYS.has(w));
    if (invalidWeekdays.length > 0) {
      errors.push({ row: rowNum, message: `不正な曜日: ${invalidWeekdays.join(', ')}` });
      continue;
    }

    const rawDaysOff = daysOffRaw
      ? daysOffRaw.split(',').map((d) => d.trim()).filter((d) => d !== '')
      : [];

    const requestedDaysOff: string[] = [];
    const invalidDates: string[] = [];
    for (const raw of rawDaysOff) {
      const n = normalizeDayOffDate(raw);
      if (n !== null) { requestedDaysOff.push(n); } else { invalidDates.push(raw); }
    }
    if (invalidDates.length > 0) {
      errors.push({ row: rowNum, message: `不正な日付: ${invalidDates.join(', ')}` });
      continue;
    }

    const maxWorkDays = parseInt(maxDaysRaw.trim(), 10);
    if (isNaN(maxWorkDays) || maxWorkDays < 1 || maxWorkDays > 31) {
      errors.push({ row: rowNum, message: `最大勤務日数が不正: ${maxDaysRaw.trim()}` });
      continue;
    }

    valid.push({
      id: crypto.randomUUID(),
      staffNo: '',
      name,
      availableWeekdays,
      requestedDaysOff,
      maxWorkDays,
      memo: memoRaw.trim(),
      preferredWorkSites: [],
    });
  }

  return { valid, errors };
}

// ── 現場CSV ───────────────────────────────────────────────

export function parseSiteCSV(rawText: string): SiteParseResult {
  const lines = stripBom(rawText)
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '');

  const errors: ParseError[] = [];

  // ── ヘッダー行からカラムインデックスを検出 ──────────────────
  // 将来の Bubble 出力列（demandId, clientName, siteId 等）が来ても壊れない
  const firstLine  = lines[0] ?? '';
  const headerLow  = parseCSVLine(firstLine).map((f) => f.trim().toLowerCase());
  const hasHeader  = headerLow.includes('date') || headerLow.includes('sitename');

  const colIdx = (name: string, fallback: number): number => {
    const i = headerLow.indexOf(name);
    return i >= 0 ? i : fallback;
  };

  const dateIdx      = colIdx('date',           0);
  const siteNameIdx  = colIdx('sitename',        1);
  const startTimeIdx = colIdx('starttime',       2);
  const endTimeIdx   = colIdx('endtime',         3);
  const reqIdx       = colIdx('requiredpeople',  4);
  const memoIdx      = colIdx('memo',            5);

  const start = hasHeader ? 1 : 0;

  // ── 行ごとにパース（生データ収集）───────────────────────────
  const rawRows: WorkSite[] = [];

  for (let i = start; i < lines.length; i++) {
    const rowNum = i + 1;
    const fields = parseCSVLine(lines[i]);

    if (fields.length < 5) {
      errors.push({ row: rowNum, message: `列数不足（${fields.length}列）` });
      continue;
    }

    const date      = (fields[dateIdx]      ?? '').trim();
    const siteName  = (fields[siteNameIdx]  ?? '').trim();
    const startTime = (fields[startTimeIdx] ?? '').trim();
    const endTime   = (fields[endTimeIdx]   ?? '').trim();
    const reqRaw    = (fields[reqIdx]       ?? '').trim();
    const memoRaw   = (fields[memoIdx]      ?? '').trim();

    if (!isValidDate(date)) {
      errors.push({ row: rowNum, message: `日付が不正: "${date}"（YYYY-MM-DD形式）` });
      continue;
    }
    if (!siteName) {
      errors.push({ row: rowNum, message: '現場名が空です' });
      continue;
    }
    if (!isValidTime(startTime)) {
      errors.push({ row: rowNum, message: `開始時間が不正: "${startTime}"（HH:MM形式）` });
      continue;
    }
    if (!isValidTime(endTime)) {
      errors.push({ row: rowNum, message: `終了時間が不正: "${endTime}"（HH:MM形式）` });
      continue;
    }

    const requiredPeople = parseInt(reqRaw, 10);
    if (isNaN(requiredPeople) || requiredPeople < 1) {
      errors.push({ row: rowNum, message: `必要人数が不正: "${reqRaw}"` });
      continue;
    }

    rawRows.push({
      id: crypto.randomUUID(),
      date,
      siteName,
      startTime,
      endTime,
      requiredPeople,
      memo: memoRaw,
      source: 'csv',
    });
  }

  // ── 日別需要モデル：同一の date+siteName+startTime+endTime を集約 ──
  // requiredPeople を加算、memo は非空・重複なしでカンマ結合
  const aggregateMap = new Map<string, WorkSite>();
  for (const row of rawRows) {
    const key = `${row.date}_${row.siteName}_${row.startTime}_${row.endTime}`;
    const hit = aggregateMap.get(key);
    if (hit) {
      hit.requiredPeople += row.requiredPeople;
      if (row.memo) {
        const parts = hit.memo ? hit.memo.split(',').map((s) => s.trim()) : [];
        if (!parts.includes(row.memo)) {
          parts.push(row.memo);
          hit.memo = parts.join(', ');
        }
      }
    } else {
      aggregateMap.set(key, { ...row });
    }
  }

  const valid = [...aggregateMap.values()].sort(
    (a, b) => a.date.localeCompare(b.date) || a.siteName.localeCompare(b.siteName)
  );

  return { valid, errors };
}

// ── 希望休CSV ─────────────────────────────────────────────

export interface DaysOffRow {
  rowNum: number;
  staffNo: string;
  name: string;
  requestedDaysOff: string[];
}

export interface DaysOffParseResult {
  rows: DaysOffRow[];
  errors: ParseError[];
}

export function parseDaysOffCSV(rawText: string, targetMonth?: string): DaysOffParseResult {
  const lines = stripBom(rawText)
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '');

  const rows: DaysOffRow[] = [];
  const errors: ParseError[] = [];

  if (lines.length === 0) return { rows, errors };

  // targetMonth（例："2026-05"）から refYear を抽出して M/D 正規化に使用
  const refYear = targetMonth ? parseInt(targetMonth.slice(0, 4), 10) : undefined;

  // ── フォーマット自動検出 ─────────────────────────────────
  const firstFields = parseCSVLine(lines[0]);
  const headerCandidates = firstFields.map((f) => f.trim().toLowerCase());
  const hasHeader = headerCandidates.some((f) =>
    ['name', 'staffno', 'date', 'requesteddaysoff'].includes(f)
  );

  let start: number;
  let isDatePerRow: boolean;
  let hasStaffNoCol: boolean;

  if (hasHeader) {
    start = 1;
    isDatePerRow = headerCandidates.includes('date');
    hasStaffNoCol = headerCandidates.includes('staffno');
  } else {
    start = 0;
    if (firstFields.length >= 3) {
      // 3列: col2が単一日付 → staffNo,name,date形式; それ以外 → batch
      isDatePerRow = isValidDate(firstFields[2].trim());
      hasStaffNoCol = isDatePerRow;
    } else if (firstFields.length === 2) {
      // 2列: col1が日付 → name,date形式
      isDatePerRow = isValidDate(firstFields[1].trim());
      hasStaffNoCol = false;
    } else {
      isDatePerRow = false;
      hasStaffNoCol = false;
    }
  }

  // ── 1行1日付形式のパース（同スタッフ行をまとめる）─────────
  if (isDatePerRow) {
    const acc = new Map<
      string,
      { staffNo: string; name: string; dates: Set<string>; firstRow: number }
    >();

    for (let i = start; i < lines.length; i++) {
      const rowNum = i + 1;
      const fields = parseCSVLine(lines[i]);

      let staffNo = '';
      let name = '';
      let dateStr = '';

      if (hasStaffNoCol && fields.length >= 3) {
        staffNo = fields[0].trim();
        name    = fields[1].trim();
        dateStr = fields[2].trim();
      } else if (!hasStaffNoCol && fields.length >= 2) {
        name    = fields[0].trim();
        dateStr = fields[1].trim();
      } else {
        errors.push({ row: rowNum, message: `列数不足（${fields.length}列）` });
        continue;
      }

      if (!staffNo && !name) {
        errors.push({ row: rowNum, message: 'スタッフNoと名前が両方空です' });
        continue;
      }
      const normalizedDate = normalizeDayOffDate(dateStr, refYear);
      if (!normalizedDate) {
        errors.push({ row: rowNum, message: `不正な日付: "${dateStr}"` });
        continue;
      }
      if (targetMonth && !normalizedDate.startsWith(targetMonth)) {
        errors.push({ row: rowNum, message: `対象月（${targetMonth}）外の日付です: "${dateStr}"` });
        continue;
      }

      const key = staffNo || name;
      if (!acc.has(key)) {
        acc.set(key, { staffNo, name, dates: new Set(), firstRow: rowNum });
      } else {
        const entry = acc.get(key)!;
        if (staffNo && !entry.staffNo) entry.staffNo = staffNo;
        if (name   && !entry.name)    entry.name    = name;
      }
      acc.get(key)!.dates.add(normalizedDate);
    }

    for (const [, entry] of acc) {
      rows.push({
        rowNum: entry.firstRow,
        staffNo: entry.staffNo,
        name: entry.name,
        requestedDaysOff: [...entry.dates].sort(),
      });
    }
    return { rows, errors };
  }

  // ── 一括形式のパース（1スタッフ1行）──────────────────────
  for (let i = start; i < lines.length; i++) {
    const rowNum = i + 1;
    const fields = parseCSVLine(lines[i]);

    if (fields.length < 2) {
      errors.push({ row: rowNum, message: `列数不足（${fields.length}列）` });
      continue;
    }

    const [staffNoRaw, nameRaw, daysOffRaw = ''] = fields;
    const staffNo = staffNoRaw.trim();
    const name    = nameRaw.trim();

    if (!staffNo && !name) {
      errors.push({ row: rowNum, message: 'スタッフNoと名前が両方空です' });
      continue;
    }

    const rawDates = daysOffRaw
      ? daysOffRaw.split(',').map((d) => d.trim()).filter((d) => d !== '')
      : [];

    const requestedDaysOff: string[] = [];
    const invalidDates: string[] = [];
    const outOfMonthDates: string[] = [];
    for (const raw of rawDates) {
      const n = normalizeDayOffDate(raw, refYear);
      if (n === null) {
        invalidDates.push(raw);
      } else if (targetMonth && !n.startsWith(targetMonth)) {
        outOfMonthDates.push(raw);
      } else {
        requestedDaysOff.push(n);
      }
    }
    if (invalidDates.length > 0) {
      errors.push({ row: rowNum, message: `不正な日付: ${invalidDates.join(', ')}` });
      continue;
    }
    if (outOfMonthDates.length > 0) {
      errors.push({ row: rowNum, message: `対象月（${targetMonth}）外のためスキップ: ${outOfMonthDates.join(', ')}` });
    }

    rows.push({ rowNum, staffNo, name, requestedDaysOff });
  }

  return { rows, errors };
}

// ── テンプレートダウンロード ──────────────────────────────
function downloadCsv(content: string, filename: string): void {
  const bom = '﻿';
  const blob = new Blob([bom + content], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function downloadStaffTemplate(): void {
  downloadCsv(
    `name,availableWeekdays,requestedDaysOff,maxWorkDays,memo\n佐藤太郎,"月,火,水,木,金","2026-05-03,2026-05-10",20,リーダー可\n田中花子,"月,水,金","2026-05-03",15,\n鈴木一郎,"土,日","",8,土日中心`,
    'staff_template.csv'
  );
}

export function downloadSiteTemplate(): void {
  downloadCsv(
    `date,siteName,startTime,endTime,requiredPeople,memo\n2026-05-01,アリオ札幌,10:00,18:00,3,通常\n2026-05-02,南郷7丁目,09:00,17:00,2,`,
    'site_template.csv'
  );
}

export function downloadDaysOffTemplate(): void {
  downloadCsv(
    `staffNo,name,requestedDaysOff\n001,セトケンスケ,"2026-05-03,2026-05-10,2026-05-18"\n002,マツハシマミ,"2026-05-01,2026-05-07"`,
    'days_off_template.csv'
  );
}

export function downloadDaysOffDateTemplate(): void {
  downloadCsv(
    `staffNo,name,date\n001,セトケンスケ,2026-05-03\n001,セトケンスケ,2026-05-10\n001,セトケンスケ,2026-05-18\n002,マツハシマミ,2026-05-01\n002,マツハシマミ,2026-05-07`,
    'days_off_date_template.csv'
  );
}
