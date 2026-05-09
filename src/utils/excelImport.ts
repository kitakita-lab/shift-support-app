import ExcelJS from 'exceljs';
import { WorkSite } from '../types';
import { ParseError } from './csvImport';

// ─── 公開型 ──────────────────────────────────────────────────

export interface ExcelSiteSession {
  clientName: string;
  siteName:   string;
  startDate:  string;
  endDate:    string;
  startTime:  string;
  endTime:    string;
  requiredPeople: number;
  memo:       string;
}

export interface ExcelSiteParseResult {
  sessions: ExcelSiteSession[]; // 会期レベル（プレビュー表示用）
  valid:    WorkSite[];         // 日付展開済み（インポート用）
  errors:   ParseError[];
}

// ─── 内部ヘルパー ─────────────────────────────────────────────

function parseDateLocal(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function cellText(cell: ExcelJS.Cell): string {
  // cell.text は RichText / 数値 / 日付を表示文字列として返す
  return (cell.text ?? String(cell.value ?? '')).trim();
}

/** ExcelJS Cell → "YYYY-MM-DD" 変換（日付型・文字列型・シリアル値に対応） */
function cellToDateString(cell: ExcelJS.Cell): string | null {
  const val = cell.value;
  if (val instanceof Date) {
    const y = val.getFullYear();
    const m = String(val.getMonth() + 1).padStart(2, '0');
    const d = String(val.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const text = cellText(cell);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const slash = text.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if (slash) {
    return `${slash[1]}-${slash[2].padStart(2, '0')}-${slash[3].padStart(2, '0')}`;
  }
  // Excel シリアル値（数値）のフォールバック
  if (typeof val === 'number' && val > 0) {
    const d = new Date(Math.round((val - 25569) * 86400000));
    const y = d.getUTCFullYear();
    const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
    const da = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${mo}-${da}`;
  }
  return null;
}

/** ExcelJS Cell → "HH:mm" 変換（時刻型・分数値・文字列に対応） */
function cellToTimeString(cell: ExcelJS.Cell): string | null {
  const val = cell.value;
  if (val instanceof Date) {
    const h = String(val.getHours()).padStart(2, '0');
    const m = String(val.getMinutes()).padStart(2, '0');
    return `${h}:${m}`;
  }
  // Excel の時刻は 0〜1 の小数で格納される（例: 0.5 = 12:00）
  if (typeof val === 'number' && val >= 0 && val < 1) {
    const totalMin = Math.round(val * 1440);
    const h = Math.floor(totalMin / 60) % 24;
    const m = totalMin % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }
  const text = cellText(cell);
  const match = text.match(/^(\d{1,2}):(\d{2})/);
  if (match) return `${match[1].padStart(2, '0')}:${match[2]}`;
  return null;
}

// ─── メイン関数 ───────────────────────────────────────────────

/**
 * .xlsx ファイルを読み込み、会期ごとの WorkSite[] へ変換する。
 * 読み込み列: clientName, siteName, subSiteName, startDate, endDate, startTime, endTime, requiredPeople, memo
 */
export async function parseExcelSiteFile(file: File): Promise<ExcelSiteParseResult> {
  const buffer = await file.arrayBuffer();
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);

  const sheet = workbook.worksheets[0];
  if (!sheet) {
    return {
      sessions: [],
      valid: [],
      errors: [{ row: 0, message: 'Excelファイルにシートが見つかりません' }],
    };
  }

  // ── ヘッダー行を解析 ──────────────────────────────────────
  const headerRow = sheet.getRow(1);
  const headers: string[] = [];
  headerRow.eachCell({ includeEmpty: true }, (cell, colNum) => {
    headers[colNum - 1] = cellText(cell).toLowerCase().replace(/\s/g, '');
  });

  const colOf = (name: string) => headers.indexOf(name);

  const siteNameCol     = colOf('sitename');
  const startDateCol    = colOf('startdate');
  const endDateCol      = colOf('enddate');
  const startTimeCol    = colOf('starttime');
  const endTimeCol      = colOf('endtime');
  const reqPeopleCol    = colOf('requiredpeople');
  const clientNameCol   = colOf('clientname');
  const subSiteNameCol  = colOf('subsitename');
  const memoCol         = colOf('memo');

  const missing: string[] = [];
  if (siteNameCol < 0)  missing.push('siteName');
  if (startDateCol < 0) missing.push('startDate');
  if (endDateCol < 0)   missing.push('endDate');
  if (startTimeCol < 0) missing.push('startTime');
  if (endTimeCol < 0)   missing.push('endTime');
  if (reqPeopleCol < 0) missing.push('requiredPeople');

  if (missing.length > 0) {
    return {
      sessions: [],
      valid: [],
      errors: [{ row: 1, message: `必須列が見つかりません: ${missing.join(', ')}` }],
    };
  }

  // ── データ行を解析 ─────────────────────────────────────────
  const sessions: ExcelSiteSession[] = [];
  const valid: WorkSite[] = [];
  const errors: ParseError[] = [];

  sheet.eachRow((row, rowNum) => {
    if (rowNum === 1) return; // ヘッダーをスキップ

    const getCell  = (col: number) => row.getCell(col + 1);
    const getText  = (col: number) => col >= 0 ? cellText(getCell(col)) : '';

    const siteNameRaw = getText(siteNameCol);

    // 完全に空の行はスキップ
    if (!siteNameRaw) {
      let hasValue = false;
      row.eachCell(() => { hasValue = true; });
      if (hasValue) {
        errors.push({ row: rowNum, message: '現場名が空です' });
      }
      return;
    }

    const clientNameRaw = getText(clientNameCol);
    const clientName    = clientNameRaw === '-' ? '' : clientNameRaw;
    const subSiteName   = getText(subSiteNameCol);
    const memo          = getText(memoCol);

    // subSiteName はスペース区切りで siteName に結合
    const siteName = subSiteName ? `${siteNameRaw} ${subSiteName}` : siteNameRaw;

    const startDate = cellToDateString(getCell(startDateCol));
    const endDate   = cellToDateString(getCell(endDateCol));
    const startTime = cellToTimeString(getCell(startTimeCol));
    const endTime   = cellToTimeString(getCell(endTimeCol));
    const reqText   = getText(reqPeopleCol);
    const requiredPeople = parseInt(reqText, 10);

    if (!startDate) {
      errors.push({ row: rowNum, message: `開始日が不正です（YYYY-MM-DD または日付型）` });
      return;
    }
    if (!endDate) {
      errors.push({ row: rowNum, message: `終了日が不正です（YYYY-MM-DD または日付型）` });
      return;
    }
    if (endDate < startDate) {
      errors.push({ row: rowNum, message: `終了日(${endDate})が開始日(${startDate})より前です` });
      return;
    }
    if (!startTime) {
      errors.push({ row: rowNum, message: `開始時間が不正です（HH:mm 形式または時刻型）` });
      return;
    }
    if (!endTime) {
      errors.push({ row: rowNum, message: `終了時間が不正です（HH:mm 形式または時刻型）` });
      return;
    }
    if (isNaN(requiredPeople) || requiredPeople < 1) {
      errors.push({ row: rowNum, message: `必要人数が不正: "${reqText}"（1以上の整数）` });
      return;
    }

    sessions.push({ clientName, siteName, startDate, endDate, startTime, endTime, requiredPeople, memo });

    // 日付範囲を展開して WorkSite を1件/日で生成
    const pad = (n: number) => String(n).padStart(2, '0');
    const cursor = parseDateLocal(startDate);
    const endD   = parseDateLocal(endDate);

    while (cursor <= endD) {
      const date = `${cursor.getFullYear()}-${pad(cursor.getMonth() + 1)}-${pad(cursor.getDate())}`;
      valid.push({
        id:              crypto.randomUUID(),
        date,
        siteName,
        rawSiteName:     siteName,
        displaySiteName: siteName,
        clientName,
        startTime,
        endTime,
        requiredPeople,
        memo:            memo || '',
        source:          'csv',
      });
      cursor.setDate(cursor.getDate() + 1);
    }
  });

  return { sessions, valid, errors };
}

/** 現場Excelテンプレートを .xlsx としてダウンロードする */
export async function downloadExcelSiteTemplate(): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('現場テンプレート');

  const headerRow = sheet.addRow([
    'clientName', 'siteName', 'subSiteName',
    'startDate', 'endDate', 'startTime', 'endTime',
    'requiredPeople', 'memo',
  ]);
  headerRow.font = { bold: true };
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD1E8FF' } };

  sheet.addRow(['千代田',       'チカホ憩い',            '2枠',   '2026-03-01', '2026-03-03', '10:00', '18:00', 2, '']);
  sheet.addRow(['ティーガイア', 'イオン厚別',             'ドンキ2', '2026-03-05', '2026-03-07', '10:00', '18:00', 2, '']);
  sheet.addRow(['-',            'アリオ ハーベストコート', '',       '2026-03-10', '2026-03-12', '10:00', '18:00', 5, '']);

  [16, 24, 12, 14, 14, 10, 10, 12, 20].forEach((w, i) => {
    sheet.getColumn(i + 1).width = w;
  });

  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'site_template.xlsx';
  a.click();
  URL.revokeObjectURL(url);
}
