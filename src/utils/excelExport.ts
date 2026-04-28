import ExcelJS from 'exceljs';
import { Staff, WorkSite, ShiftAssignment } from '../types';

const COL_WIDTHS = [14, 22, 10, 10, 10, 44, 10];

const HEADER_LABELS = [
  '日付', '現場名', '開始時間', '終了時間', '必要人数', '割当スタッフ', '不足人数',
];

// ヘッダーセルのスタイル
const HEADER_FILL: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FF1A56DB' },
};
const HEADER_FONT: Partial<ExcelJS.Font> = {
  bold: true, color: { argb: 'FFFFFFFF' }, size: 11,
};

// 不足行の背景
const SHORTAGE_FILL: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FFFEE2E2' },
};
const SHORTAGE_FONT: Partial<ExcelJS.Font> = {
  bold: true, color: { argb: 'FFDC2626' },
};

// 通常行（偶数）の背景
const ALT_FILL: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FFF8FAFF' },
};

const CENTER: Partial<ExcelJS.Alignment> = { vertical: 'middle', horizontal: 'center' };
const MIDDLE: Partial<ExcelJS.Alignment> = { vertical: 'middle' };

function thinBorder(color = 'FFE5E7EB'): Partial<ExcelJS.Borders> {
  const side: Partial<ExcelJS.Border> = { style: 'thin', color: { argb: color } };
  return { top: side, bottom: side, left: side, right: side };
}

export async function exportExcel(
  workSites: WorkSite[],
  assignments: ShiftAssignment[],
  staff: Staff[]
): Promise<void> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'シフト作成サポート';
  wb.created = new Date();

  const ws = wb.addWorksheet('シフト表');

  // 列幅
  ws.columns = COL_WIDTHS.map((width) => ({ width }));

  // ── ヘッダー行 ──────────────────────────────────────────
  const headerRow = ws.addRow(HEADER_LABELS);
  headerRow.height = 26;
  headerRow.eachCell((cell) => {
    cell.font      = HEADER_FONT;
    cell.fill      = HEADER_FILL;
    cell.alignment = CENTER;
    cell.border    = thinBorder('FF1A56DB');
  });

  // ── データ準備 ──────────────────────────────────────────
  const staffMap: Record<string, string> = {};
  staff.forEach((s) => (staffMap[s.id] = s.name));

  const assignMap: Record<string, ShiftAssignment> = {};
  assignments.forEach((a) => (assignMap[a.siteId] = a));

  const sorted = [...workSites].sort((a, b) => a.date.localeCompare(b.date));

  // ── データ行（スタッフ1人につき1行に展開）────────────────
  sorted.forEach((site, idx) => {
    const asgn     = assignMap[site.id];
    const shortage = asgn ? asgn.shortage : site.requiredPeople;
    const hasShortage = shortage > 0;
    // 同一現場の行は同じ idx を使って縞模様を統一する
    const isAlt = idx % 2 === 1;

    // 割当スタッフを1名ずつ展開。未割当なら空行を1行出す
    const staffNames =
      asgn && asgn.assignedStaffIds.length > 0
        ? asgn.assignedStaffIds.map((id) => staffMap[id] ?? id)
        : [''];

    staffNames.forEach((staffName) => {
      const row = ws.addRow([
        site.date,
        site.siteName,
        site.startTime,
        site.endTime,
        site.requiredPeople,
        staffName,
        shortage,
      ]);
      row.height = 20;

      row.eachCell({ includeEmpty: true }, (cell, colNum) => {
        cell.border    = thinBorder();
        cell.alignment = colNum === 6 ? MIDDLE : CENTER;

        if (hasShortage) {
          cell.fill = SHORTAGE_FILL;
        } else if (isAlt) {
          cell.fill = ALT_FILL;
        }
      });

      // 不足人数セルを強調
      if (hasShortage) {
        row.getCell(7).font = SHORTAGE_FONT;
      }
    });
  });

  // ── ダウンロード ────────────────────────────────────────
  const today  = new Date().toISOString().slice(0, 10);
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
