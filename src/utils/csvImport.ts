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

    const requestedDaysOff = daysOffRaw
      ? daysOffRaw.split(',').map((d) => d.trim()).filter((d) => d !== '')
      : [];

    const invalidDates = requestedDaysOff.filter((d) => !isValidDate(d));
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
    });
  }

  return { valid, errors };
}

// ── 現場CSV ───────────────────────────────────────────────

export function parseSiteCSV(rawText: string): SiteParseResult {
  const lines = stripBom(rawText)
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '');

  const valid: WorkSite[] = [];
  const errors: ParseError[] = [];

  const start = lines[0]?.toLowerCase().startsWith('date') ? 1 : 0;

  for (let i = start; i < lines.length; i++) {
    const rowNum = i + 1;
    const fields = parseCSVLine(lines[i]);

    if (fields.length < 5) {
      errors.push({ row: rowNum, message: `列数不足（${fields.length}列）` });
      continue;
    }

    const [dateRaw, siteNameRaw, startTimeRaw, endTimeRaw, reqRaw, memoRaw = ''] = fields;
    const date = dateRaw.trim();
    const siteName = siteNameRaw.trim();
    const startTime = startTimeRaw.trim();
    const endTime = endTimeRaw.trim();

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

    const requiredPeople = parseInt(reqRaw.trim(), 10);
    if (isNaN(requiredPeople) || requiredPeople < 1) {
      errors.push({ row: rowNum, message: `必要人数が不正: "${reqRaw.trim()}"` });
      continue;
    }

    valid.push({
      id: crypto.randomUUID(),
      date,
      siteName,
      startTime,
      endTime,
      requiredPeople,
      memo: memoRaw.trim(),
    });
  }

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

export function parseDaysOffCSV(rawText: string): DaysOffParseResult {
  const lines = stripBom(rawText)
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '');

  const rows: DaysOffRow[] = [];
  const errors: ParseError[] = [];

  const first = lines[0]?.toLowerCase() ?? '';
  const start = first.startsWith('staffno') || first.startsWith('name') ? 1 : 0;

  for (let i = start; i < lines.length; i++) {
    const rowNum = i + 1;
    const fields = parseCSVLine(lines[i]);

    if (fields.length < 2) {
      errors.push({ row: rowNum, message: `列数不足（${fields.length}列）` });
      continue;
    }

    const [staffNoRaw, nameRaw, daysOffRaw = ''] = fields;
    const staffNo = staffNoRaw.trim();
    const name = nameRaw.trim();

    if (!staffNo && !name) {
      errors.push({ row: rowNum, message: 'スタッフNoと名前が両方空です' });
      continue;
    }

    const requestedDaysOff = daysOffRaw
      ? daysOffRaw.split(',').map((d) => d.trim()).filter((d) => d !== '')
      : [];

    const invalidDates = requestedDaysOff.filter((d) => !isValidDate(d));
    if (invalidDates.length > 0) {
      errors.push({ row: rowNum, message: `不正な日付: ${invalidDates.join(', ')}` });
      continue;
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
    `name,availableWeekdays,requestedDaysOff,maxWorkDays,memo\n佐藤太郎,"月,火,水,木,金",,20,リーダー可\n田中花子,"月,水,金","2026-05-03",15,`,
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
