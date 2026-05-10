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
// 現場大ブロック見出し（濃紺：最も目立つ）
const BLOCK_TITLE_FILL: ExcelJS.Fill = {
  type: 'pattern', pattern: 'solid',
  fgColor: { argb: 'FF1E3A8A' },
};
const BLOCK_TITLE_FONT: Partial<ExcelJS.Font> = {
  bold: true, size: 12, color: { argb: 'FFFFFFFF' },
};
// 会期情報行（薄水色：現場行より控えめ）
const BLOCK_INFO_FILL: ExcelJS.Fill = {
  type: 'pattern', pattern: 'solid',
  fgColor: { argb: 'FFE8F0FE' },
};
const BLOCK_INFO_FONT: Partial<ExcelJS.Font> = {
  size: 10, color: { argb: 'FF475569' },
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

// スタッフ別明細シート用：単一スタッフ列を左寄せ
function styleDataRow(
  row: ExcelJS.Row,
  hasShortage: boolean,
  isAlt: boolean,
  staffCol: number,
  shortageCol: number
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

// 現場別シフト表シート用：スタッフ列が範囲になる横持ち形式
function styleSiteSheetRow(
  row: ExcelJS.Row,
  hasShortage: boolean,
  isAlt: boolean,
  staffStartCol: number,
  staffEndCol: number,
  shortageCol: number
): void {
  row.height = 20;
  row.eachCell({ includeEmpty: true }, (cell, colNum) => {
    cell.border    = thinBorder();
    cell.alignment = (colNum >= staffStartCol && colNum <= staffEndCol) ? MIDDLE : CENTER;
    if (hasShortage)    cell.fill = SHORTAGE_FILL;
    else if (isAlt)     cell.fill = ALT_FILL;
  });
  if (hasShortage) row.getCell(shortageCol).font = SHORTAGE_FONT;
}

// 現場ブロック見出し用ラベル。
// subSiteName と clientName の両方がある場合に二重括弧にならないよう独自生成する。
// 例: siteName="Bivi新札幌" sub="2階1ドラッグ側" client="千代田"
//     → "Bivi新札幌（2階1ドラッグ側）　千代田"
function buildVenueLabel(siteName: string, subSiteName?: string, clientName?: string): string {
  const sub    = subSiteName?.trim();
  const client = clientName?.trim();
  if (sub && client) return `${siteName}（${sub}）　${client}`;
  if (sub)           return `${siteName}（${sub}）`;
  if (client)        return `${siteName}（${client}）`;
  return siteName;
}

// ── シート①：現場別シフト表（現場大ブロック + 会期小ブロック形式）──────────────
//
// [Excel再取込 照合キー設計メモ — 実装は将来]
// 照合キー候補（一時的・永続化しない）:
//   対象月 + 現場名 + クライアント名 + 日付 + 開始時間 + 終了時間
// 設計方針:
//   - requiredPeople は照合キーに含めない（担当者が事前に変更する場合があるため）
//   - groupId / siteId / sessionId はExcel出力に含めない（内部キーはアプリ内に留める）
//   - Excelは人間が編集する前提のため、照合時は trim() で空白差異を吸収する
//   - 再取込の更新対象は ShiftAssignment のみ。スタッフマスタ・現場マスタは変更しない
//   - スタッフ名→IDの逆引きは staffMap を使用し、不一致は自動変換せずエラー扱いにする

interface SiteBlock {
  venueLabel:       string;
  siteName:         string;    // 親会場名のみ（displaySiteName ではない）
  subSiteName?:     string;    // サブ会場名（独立フィールド）
  clientName?:      string;
  startDate:        string;
  endDate:          string;
  startTime:        string;
  endTime:          string;
  maxRequired:      number;   // このセッション内の必要人数最大値
  maxAssignedCount: number;   // このセッション内で最も多く配置された人数
  maxShortage:      number;   // このセッション内の不足人数最大値
  staffColCount:    number;   // max(maxRequired, maxAssignedCount, 1)
  sites:            WorkSite[];
}

interface VenueGroup {
  venueLabel: string;
  sessions:   SiteBlock[];
}

/** sorted（日付昇順）を sessionId 単位でブロックに分割する */
function buildBlocks(
  sorted: WorkSite[],
  assignMap: Record<string, ShiftAssignment>
): SiteBlock[] {
  const sessionMap = new Map<string, WorkSite[]>();

  for (const site of sorted) {
    // sessionId がある場合はそれを使う（正常系）。ない場合は複合キーで代替（旧データ互換）
    const key = site.sessionId
      ? `s:${site.sessionId}`
      : `f:${(site.clientName ?? '').trim()}\0${site.siteName.trim()}\0${(site.subSiteName ?? '').trim()}:${site.startTime}:${site.endTime}`;
    if (!sessionMap.has(key)) sessionMap.set(key, []);
    sessionMap.get(key)!.push(site);
  }

  const blocks: SiteBlock[] = [];
  for (const [, sites] of sessionMap) {
    const s = [...sites].sort((a, b) => a.date.localeCompare(b.date));
    const maxRequired = Math.max(...s.map((x) => x.requiredPeople));
    const maxAssignedCount = s.reduce(
      (acc, x) => Math.max(acc, assignMap[x.id]?.assignedStaffIds.length ?? 0),
      0
    );
    // 日別の shortage を集計して会期内最大値を求める
    const maxShortage = s.reduce((acc, x) => {
      const asgn = assignMap[x.id];
      return Math.max(acc, asgn ? asgn.shortage : x.requiredPeople);
    }, 0);
    const first = s[0];
    blocks.push({
      venueLabel:       buildVenueLabel(first.siteName, first.subSiteName, first.clientName),
      siteName:         first.siteName,
      subSiteName:      first.subSiteName,
      clientName:       first.clientName,
      startDate:        first.date,
      endDate:          s[s.length - 1].date,
      startTime:        first.startTime,
      endTime:          first.endTime,
      maxRequired,
      maxAssignedCount,
      maxShortage,
      staffColCount:    Math.max(maxRequired, maxAssignedCount, 1),
      sites:            s,
    });
  }

  // 開始日昇順 → 会場名昇順で並べる
  return blocks.sort(
    (a, b) => a.startDate.localeCompare(b.startDate) || a.venueLabel.localeCompare(b.venueLabel)
  );
}

/** セッションブロックを 現場名+クライアント名 単位の大グループに集約する */
function buildVenueGroups(
  sorted: WorkSite[],
  assignMap: Record<string, ShiftAssignment>
): VenueGroup[] {
  const blocks = buildBlocks(sorted, assignMap);
  const venueMap = new Map<string, SiteBlock[]>();

  for (const block of blocks) {
    const key = `${(block.clientName ?? '').trim()}\0${block.siteName.trim()}\0${(block.subSiteName ?? '').trim()}`;
    if (!venueMap.has(key)) venueMap.set(key, []);
    venueMap.get(key)!.push(block);
  }

  const groups: VenueGroup[] = [];
  for (const [, sessions] of venueMap) {
    groups.push({
      venueLabel: sessions[0].venueLabel,
      sessions,   // buildBlocks の sort 順を引き継ぐ（startDate 昇順）
    });
  }

  // 各グループの最初の会期開始日昇順 → 会場名昇順
  return groups.sort(
    (a, b) =>
      a.sessions[0].startDate.localeCompare(b.sessions[0].startDate) ||
      a.venueLabel.localeCompare(b.venueLabel)
  );
}

function buildSiteSheet(
  wb: ExcelJS.Workbook,
  sorted: WorkSite[],
  assignMap: Record<string, ShiftAssignment>,
  staffMap: Record<string, string>,
  staffIndex: Record<string, Staff>
): void {
  const ws = wb.addWorksheet('現場別シフト表');

  const venueGroups = buildVenueGroups(sorted, assignMap);
  if (venueGroups.length === 0) return;

  // スタッフ名の最大文字数からスタッフ列幅を決定（名前が切れないよう調整）
  const maxNameChars = Object.values(staffMap).reduce(
    (max, name) => Math.max(max, name.length), 0
  );
  const staffColWidth = Math.min(20, Math.max(10, maxNameChars + 6));

  // シート全体の最大スタッフ列数（全現場・全会期横断）
  const globalMaxN   = Math.max(...venueGroups.flatMap((g) => g.sessions.map((b) => b.staffColCount)));
  // 列構成：日付(1) | スタッフ1..N(2..1+N) | 不足人数(2+N) | メモ(3+N)
  const TOTAL_COLS   = 3 + globalMaxN;
  const STAFF_START  = 2;
  const STAFF_END    = 1 + globalMaxN;
  const SHORTAGE_COL = STAFF_END + 1;

  ws.columns = [
    14,                                // 日付（固定）
    ...Array(globalMaxN).fill(staffColWidth),  // スタッフ1〜N（名前長に応じて可変）
    10,                                // 不足人数
    22,                                // メモ
  ].map((width) => ({ width }));

  venueGroups.forEach((venue, venueIdx) => {
    // 現場大ブロック間スペーサー（先頭は不要）
    if (venueIdx > 0) ws.addRow([]);

    // ── 現場大ブロック見出し ───────────────────────────────────
    const venueTitleRow = ws.addRow([venue.venueLabel]);
    venueTitleRow.height = 28;
    ws.mergeCells(venueTitleRow.number, 1, venueTitleRow.number, TOTAL_COLS);
    const venueTitleCell     = venueTitleRow.getCell(1);
    venueTitleCell.font      = BLOCK_TITLE_FONT;
    venueTitleCell.fill      = BLOCK_TITLE_FILL;
    venueTitleCell.alignment = { vertical: 'middle', indent: 1 };
    venueTitleCell.border    = thinBorder('FF1E3A8A');

    venue.sessions.forEach((block, sessionIdx) => {
      // ── 会期情報行（期間・時刻・人数サマリー）──────────────────────
      const dateLabel = block.startDate === block.endDate
        ? block.startDate
        : `${block.startDate} 〜 ${block.endDate}`;
      const baseText = `会期：${dateLabel}　　開始：${block.startTime}　終了：${block.endTime}　　必要人数：${block.maxRequired}人　割当最大：${block.maxAssignedCount}人　`;

      const infoRow = ws.addRow(['']);
      infoRow.height = 18;
      ws.mergeCells(infoRow.number, 1, infoRow.number, TOTAL_COLS);
      const infoCell     = infoRow.getCell(1);
      infoCell.fill      = BLOCK_INFO_FILL;
      infoCell.alignment = { vertical: 'middle', indent: 2 };
      infoCell.border    = thinBorder('FFE2E8F0');

      // 不足あり → 不足人数部分を赤字のrichTextで表示
      if (block.maxShortage > 0) {
        infoCell.value = {
          richText: [
            { text: baseText,                              font: { size: 10, color: { argb: 'FF475569' } } },
            { text: `不足最大：${block.maxShortage}人`,   font: { size: 10, bold: true, color: { argb: 'FFDC2626' } } },
          ],
        };
      } else {
        infoCell.value = baseText + '不足なし';
        infoCell.font  = BLOCK_INFO_FONT;
      }

      // ── 列ヘッダー行（このブロックのスタッフ数まで名前を出す）──
      const staffHeaders = Array.from({ length: globalMaxN }, (_, i) =>
        i < block.staffColCount ? `スタッフ${i + 1}` : ''
      );
      const colHdrRow = ws.addRow(['日付', ...staffHeaders, '不足人数', 'メモ']);
      colHdrRow.height = 22;
      colHdrRow.eachCell({ includeEmpty: true }, (cell) => {
        cell.font      = HEADER_FONT;
        cell.fill      = HEADER_FILL;
        cell.alignment = CENTER;
        cell.border    = thinBorder('FF1A56DB');
      });

      // ── データ行（1現場1日 = 1行）────────────────────────────
      // スタッフ未配置セルは完全空白（「-」や「未設定」は入れない）
      block.sites.forEach((site, siteIdx) => {
        const asgn     = assignMap[site.id];
        const shortage = asgn ? asgn.shortage : site.requiredPeople;
        const staffIds = asgn && asgn.assignedStaffIds.length > 0
          ? sortedByStaffNo(asgn.assignedStaffIds, staffIndex)
          : [];
        const staffCells = Array.from({ length: globalMaxN }, (_, i) =>
          staffIds[i] ? (staffMap[staffIds[i]] ?? staffIds[i]) : ''
        );

        const row = ws.addRow([
          site.date,
          ...staffCells,
          shortage,
          site.memo ?? '',
        ]);

        styleSiteSheetRow(row, shortage > 0, siteIdx % 2 === 1, STAFF_START, STAFF_END, SHORTAGE_COL);
      });

      // ── 会期間セパレータ（同一現場内の会期境界を視覚化・最終会期の後は不要）──
      if (sessionIdx < venue.sessions.length - 1) {
        const sepRow = ws.addRow([]);
        sepRow.height = 8;
        for (let c = 1; c <= TOTAL_COLS; c++) {
          sepRow.getCell(c).fill = {
            type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' },
          };
        }
      }
    });
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

  // 列幅：日付, 現場名, クライアント名, 開始時間, 終了時間, 必要人数, スタッフ名, 不足人数
  ws.columns = [14, 22, 20, 10, 10, 10, 30, 10].map((width) => ({ width }));

  styleHeader(ws.addRow(['日付', '現場名', 'クライアント名', '開始時間', '終了時間', '必要人数', 'スタッフ名', '不足人数']));

  sorted.forEach((site, idx) => {
    const asgn        = assignMap[site.id];
    const shortage    = asgn ? asgn.shortage : site.requiredPeople;
    const hasShortage = shortage > 0;
    const isAlt       = idx % 2 === 1;

    // スタッフを1人ずつ展開。未割当なら空行を1行出す
    const names = asgn && asgn.assignedStaffIds.length > 0
      ? sortedByStaffNo(asgn.assignedStaffIds, staffIndex).map((id) => staffMap[id] ?? id)
      : [''];

    names.forEach((staffName) => {
      const row = ws.addRow([
        site.date,
        site.displaySiteName ?? site.siteName,
        site.clientName ?? '',
        site.startTime,
        site.endTime,
        site.requiredPeople,
        staffName,
        shortage,
      ]);

      // 7列目=スタッフ名（左寄せ）、8列目=不足人数
      styleDataRow(row, hasShortage, isAlt, 7, 8);
    });
  });
}

// ── メイン関数 ────────────────────────────────────────────

export async function exportExcel(
  workSites: WorkSite[],
  assignments: ShiftAssignment[],
  staff: Staff[],
  filename?: string
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

  const _now  = new Date();
  const pad   = (n: number) => n.toString().padStart(2, '0');
  const today = `${_now.getFullYear()}-${pad(_now.getMonth() + 1)}-${pad(_now.getDate())}`;
  const buffer = await wb.xlsx.writeBuffer();
  const blob   = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href     = url;
  a.download = filename ?? `shift_schedule_${today}.xlsx`;
  a.click();
  URL.revokeObjectURL(url);
}
