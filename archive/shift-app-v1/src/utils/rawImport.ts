import ExcelJS from 'exceljs';

// ── 型定義 ────────────────────────────────────────────────────

export interface RawSheet {
  fileName: string;
  headers:  string[];
  rows:     RawRow[];
}

export interface RawRow {
  rowNum: number;
  cells:  string[];
}

/** 0-based 列インデックス。null = マッピングなし */
export interface ColumnMapping {
  siteName:       number | null;
  subSiteName:    number | null;
  startDate:      number | null;
  endDate:        number | null;
  startTime:      number | null;
  endTime:        number | null;
  requiredPeople: number | null;
  clientName:     number | null;
  memo:           number | null;
}

export type MappingKey = keyof ColumnMapping;

export const MAPPING_LABELS: Record<MappingKey, string> = {
  siteName:       '会場名',
  subSiteName:    'サブ会場名',
  startDate:      '開始日',
  endDate:        '終了日',
  startTime:      '開始時間',
  endTime:        '終了時間',
  requiredPeople: '必要人数',
  clientName:     'クライアント名',
  memo:           'メモ',
};

export const REQUIRED_MAPPING_KEYS: MappingKey[] = [
  'siteName', 'startDate', 'endDate', 'startTime', 'endTime', 'requiredPeople',
];

export interface ParsedSessionRow {
  rowNum:         number;
  rawSiteName:    string;   // ファイルから取得したまま保持（normalize しない）
  subSiteNameRaw: string;
  clientName:     string;   // ファイル列 or fallback 入力値
  startDate:      string;   // YYYY-MM-DD または ''
  endDate:        string;
  startTime:      string;   // HH:mm または ''
  endTime:        string;
  requiredPeople: number | null;
  memo:           string;
  errors:         string[];
}

// ── CSV 読込 ──────────────────────────────────────────────────

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') { inQ = false; }
      else { cur += c; }
    } else {
      if (c === '"') { inQ = true; }
      else if (c === ',') { cells.push(cur.trim()); cur = ''; }
      else { cur += c; }
    }
  }
  cells.push(cur.trim());
  return cells;
}

export function readRawCsv(text: string, fileName: string): RawSheet {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const nonEmpty = lines.map((line, i) => ({ line, origIdx: i })).filter(({ line }) => line.trim());
  if (nonEmpty.length === 0) return { fileName, headers: [], rows: [] };

  const headers = parseCsvLine(nonEmpty[0].line);
  const rows: RawRow[] = nonEmpty.slice(1).map(({ line, origIdx }) => {
    const cells = parseCsvLine(line);
    while (cells.length < headers.length) cells.push('');
    return { rowNum: origIdx + 1, cells };
  });
  return { fileName, headers, rows };
}

// ── Excel 読込 ────────────────────────────────────────────────

function cellStr(cell: ExcelJS.Cell): string {
  return (cell.text ?? String(cell.value ?? '')).trim();
}

export async function readRawExcel(file: File): Promise<RawSheet> {
  const buffer = await file.arrayBuffer();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const sheet = wb.worksheets[0];
  if (!sheet) return { fileName: file.name, headers: [], rows: [] };

  const headerRow = sheet.getRow(1);
  const headers: string[] = [];
  headerRow.eachCell({ includeEmpty: true }, (cell) => { headers.push(cellStr(cell)); });
  while (headers.length > 0 && !headers[headers.length - 1]) headers.pop();

  const rows: RawRow[] = [];
  sheet.eachRow((row, rowNum) => {
    if (rowNum === 1) return;
    const cells: string[] = [];
    row.eachCell({ includeEmpty: true }, (cell) => { cells.push(cellStr(cell)); });
    while (cells.length < headers.length) cells.push('');
    if (cells.some((c) => c !== '')) rows.push({ rowNum, cells });
  });

  return { fileName: file.name, headers, rows };
}

// ── 列自動推定 ────────────────────────────────────────────────

const HEADER_PATTERNS: Record<MappingKey, string[]> = {
  siteName:       ['sitename', '現場名', '会場名', '施設名', 'venue'],
  subSiteName:    ['subsitename', 'サブ会場名', '売場名', 'ブース名', '枠'],
  startDate:      ['startdate', '開始日', '初日', '搬入日'],
  endDate:        ['enddate', '終了日', '最終日', '最終稼働日', '撤収日'],
  startTime:      ['starttime', '開始時間', '開始', '開場'],
  endTime:        ['endtime', '終了時間', '終了', '終場', '閉場'],
  requiredPeople: ['requiredpeople', '必要人数', '人数', '配置人数', '派遣人数'],
  clientName:     ['clientname', 'クライアント名', 'クライアント', '担当会社', '会社名'],
  memo:           ['memo', 'メモ', '備考', '注記'],
};

export function autoDetectMapping(headers: string[]): ColumnMapping {
  const norm = (s: string) =>
    s.toLowerCase().replace(/[\s　_\-・]/g, '').replace(/[（）()]/g, '');
  const used = new Set<number>();
  const mapping: ColumnMapping = {
    siteName: null, subSiteName: null,
    startDate: null, endDate: null,
    startTime: null, endTime: null,
    requiredPeople: null, clientName: null, memo: null,
  };
  for (const key of Object.keys(mapping) as MappingKey[]) {
    for (const pattern of HEADER_PATTERNS[key]) {
      const idx = headers.findIndex((h, i) => !used.has(i) && norm(h) === norm(pattern));
      if (idx >= 0) { mapping[key] = idx; used.add(idx); break; }
    }
  }
  return mapping;
}

// ── 日付・時刻パース ──────────────────────────────────────────

export function parseRawDate(raw: string): string {
  const s = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m1 = s.match(/^(\d{4})[\/.](\d{1,2})[\/.](\d{1,2})$/);
  if (m1) return `${m1[1]}-${m1[2].padStart(2, '0')}-${m1[3].padStart(2, '0')}`;
  const m2 = s.match(/^(\d{1,2})[\/.](\d{1,2})[\/.](\d{4})$/);
  if (m2) return `${m2[3]}-${m2[1].padStart(2, '0')}-${m2[2].padStart(2, '0')}`;
  return '';
}

export function parseRawTime(raw: string): string {
  const m = raw.trim().match(/^(\d{1,2}):(\d{2})/);
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : '';
}

// ── マッピング適用 ────────────────────────────────────────────

export function applyMapping(
  sheet:              RawSheet,
  mapping:            ColumnMapping,
  fallbackClientName: string,
): ParsedSessionRow[] {
  const get = (row: RawRow, col: number | null) => col !== null ? (row.cells[col] ?? '') : '';

  return sheet.rows.map((row) => {
    const errors: string[] = [];
    const rawSiteName    = get(row, mapping.siteName);
    const subSiteNameRaw = get(row, mapping.subSiteName);
    const clientNameFile = get(row, mapping.clientName);
    // clientName 優先順位（この時点での確定）:
    //   1. ファイル内の clientName 列 (clientNameFile)
    //   2. ウィザード Step2 でユーザーが入力したデフォルト値 (fallbackClientName)
    //   3. siteName 括弧からの自動抽出 → applySiteNormalize 内で後から適用
    const clientName     = clientNameFile.trim() || fallbackClientName;

    if (!rawSiteName) errors.push('会場名が空です');

    const rawSD = get(row, mapping.startDate);
    const rawED = get(row, mapping.endDate);
    const startDate = parseRawDate(rawSD);
    const endDate   = parseRawDate(rawED);
    if (rawSD && !startDate) errors.push(`開始日が不正: "${rawSD}"`);
    if (rawED && !endDate)   errors.push(`終了日が不正: "${rawED}"`);
    if (startDate && endDate && endDate < startDate) errors.push('終了日が開始日より前です');

    const startTime = parseRawTime(get(row, mapping.startTime));
    const endTime   = parseRawTime(get(row, mapping.endTime));
    if (mapping.startTime !== null && get(row, mapping.startTime) && !startTime) errors.push('開始時間が不正です');
    if (mapping.endTime   !== null && get(row, mapping.endTime)   && !endTime)   errors.push('終了時間が不正です');

    const reqRaw = get(row, mapping.requiredPeople);
    const reqNum = reqRaw ? parseInt(reqRaw, 10) : null;
    if (reqRaw && (reqNum === null || isNaN(reqNum) || reqNum < 1)) errors.push(`必要人数が不正: "${reqRaw}"`);

    return {
      rowNum:         row.rowNum,
      rawSiteName,
      subSiteNameRaw,
      clientName,
      startDate,
      endDate,
      startTime,
      endTime,
      requiredPeople: reqNum !== null && !isNaN(reqNum) && reqNum >= 1 ? reqNum : null,
      memo:           get(row, mapping.memo),
      errors,
    };
  });
}
