import ExcelJS from 'exceljs';
import { Staff, WorkSite, ShiftAssignment } from '../types';
import { sortedByStaffNo } from './staffUtils';

// ── 共通スタイル定数 ───────────────────────────────────────

const HEADER_FILL: ExcelJS.Fill = {
  type: 'pattern', pattern: 'solid',
  fgColor: { argb: 'FF1A56DB' },
};
const HEADER_FONT: Partial<ExcelJS.Font> = {
  bold: true, color: { argb: 'FFFFFFFF' }, size: 11,
};
const SHORTAGE_FILL: ExcelJS.Fill = {
  type: 'pattern', pattern: 'solid',
  fgColor: { argb: 'FFFEE2E2' },
};
const SHORTAGE_FONT: Partial<ExcelJS.Font> = {
  bold: true, color: { argb: 'FFDC2626' },
};
const ALT_FILL: ExcelJS.Fill = {
  type: 'pattern', pattern: 'solid',
  fgColor: { argb: 'FFF8FAFF' },
};

const CENTER: Partial<ExcelJS.Alignment> = { vertical: 'middle', horizontal: 'center' };
const MIDDLE: Partial<ExcelJS.Alignment> = { vertical: 'middle' };

function thinBorder(color = 'FFE5E7EB'): Partial<ExcelJS.Borders> {
  const side: Partial<ExcelJS.Border> = { style: 'thin', color: { argb: color } };
  return { top: side, bottom: side, left: side, right: side };
}

// ── 共通ヘルパー ───────────────────────────────────────────

function styleHeader(row: ExcelJS.Row): void {
  row.height = 26;
  row.eachCell((cell) => {
    cell.font      = HEADER_FONT;
    cell.fill      = HEADER_FILL;
    cell.alignment = CENTER;
    cell.border    = thinBorder('FF1A56DB');
  });
}

function styleDataRow(
  row: ExcelJS.Row,
  hasShortage: boolean,
  isAlt: boolean,
  staffCol: number,   // テキスト左寄せにする列番号
  shortageCol: number // 不足強調する列番号
): void {
  row.height = 20;
  row.eachCell({ includeEmpty: true }, (cell, colNum) => {
    cell.border    = thinBorder();
    cell.alignment = colNum === staffCol ? MIDDLE : CENTER;
    if (hasShortage)    cell.fill = SHORTAGE_FILL;
    else if (isAlt)     cell.fill = ALT_FILL;
  });
  if (hasShortage) row.getCell(shortageCol).font = SHORTAGE_FONT;
}

// ── シート①：現場別シフト表（1現場1行・確認用）────────────

function buildSiteSheet(
  wb: ExcelJS.Workbook,
  sorted: WorkSite[],
  assignMap: Record<string, ShiftAssignment>,
  staffMap: Record<string, string>,
  staffIndex: Record<string, Staff>
): void {
  const ws = wb.addWorksheet('現場別シフト表');

  // 列幅：日付, 現場名, 時間, 必要人数, 割当スタッフ, 不足人数
  ws.columns = [14, 22, 16, 10, 48, 10].map((width) => ({ width }));

  styleHeader(ws.addRow(['日付', '現場名', '時間', '必要人数', '割当スタッフ', '不足人数']));

  sorted.forEach((site, idx) => {
    const asgn      = assignMap[site.id];
    const shortage  = asgn ? asgn.shortage : site.requiredPeople;
    const staffNames = asgn && asgn.assignedStaffIds.length > 0
      ? sortedByStaffNo(asgn.assignedStaffIds, staffIndex).map((id) => staffMap[id] ?? id).join('、')
      : '';

    const row = ws.addRow([
      site.date,
      site.siteName,
      `${site.startTime}〜${site.endTime}`,
      site.requiredPeople,
      staffNames,
      shortage,
    ]);

    // 5列目=割当スタッフ（左寄せ）、6列目=不足人数
    styleDataRow(row, shortage > 0, idx % 2 === 1, 5, 6);
  });
}

// ── シート②：スタッフ別明細（1スタッフ1行・集計用）─────────

function buildStaffSheet(
  wb: ExcelJS.Workbook,
  sorted: WorkSite[],
  assignMap: Record<string, ShiftAssignment>,
  staffMap: Record<string, string>,
  staffIndex: Record<string, Staff>
): void {
  const ws = wb.addWorksheet('スタッフ別明細');

  // 列幅：日付, 現場名, 開始時間, 終了時間, 必要人数, スタッフ名, 不足人数
  ws.columns = [14, 22, 10, 10, 10, 30, 10].map((width) => ({ width }));

  styleHeader(ws.addRow(['日付', '現場名', '開始時間', '終了時間', '必要人数', 'スタッフ名', '不足人数']));

  sorted.forEach((site, idx) => {
    const asgn       = assignMap[site.id];
    const shortage   = asgn ? asgn.shortage : site.requiredPeople;
    const hasShortage = shortage > 0;
    const isAlt      = idx % 2 === 1;

    // スタッフを1人ずつ展開。未割当なら空行を1行出す
    const names = asgn && asgn.assignedStaffIds.length > 0
      ? sortedByStaffNo(asgn.assignedStaffIds, staffIndex).map((id) => staffMap[id] ?? id)
      : [''];

    names.forEach((staffName) => {
      const row = ws.addRow([
        site.date,
        site.siteName,
        site.startTime,
        site.endTime,
        site.requiredPeople,
        staffName,
        shortage,
      ]);

      // 6列目=スタッフ名（左寄せ）、7列目=不足人数
      styleDataRow(row, hasShortage, isAlt, 6, 7);
    });
  });
}

// ── メイン関数 ────────────────────────────────────────────

export async function exportExcel(
  workSites: WorkSite[],
  assignments: ShiftAssignment[],
  staff: Staff[]
): Promise<void> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'シフト作成サポート';
  wb.created = new Date();

  const staffMap: Record<string, string> = {};
  const staffIndex: Record<string, Staff> = {};
  staff.forEach((s) => {
    staffMap[s.id] = s.name;
    staffIndex[s.id] = s;
  });

  const assignMap: Record<string, ShiftAssignment> = {};
  assignments.forEach((a) => (assignMap[a.siteId] = a));

  const sorted = [...workSites.filter((s) => !s.isPlaceholder)].sort((a, b) => a.date.localeCompare(b.date));

  buildSiteSheet(wb, sorted, assignMap, staffMap, staffIndex);
  buildStaffSheet(wb, sorted, assignMap, staffMap, staffIndex);

  const _now   = new Date();
  const today  = `${_now.getFullYear()}-${String(_now.getMonth() + 1).padStart(2, '0')}-${String(_now.getDate()).padStart(2, '0')}`;
  const buffer = await wb.xlsx.writeBuffer();
  const blob   = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href     = url;
  a.download = `shift_schedule_${today}.xlsx`;
  a.click();
  URL.revokeObjectURL(url);
}
