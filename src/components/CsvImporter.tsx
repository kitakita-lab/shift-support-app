import { useRef, useState, useMemo, useEffect } from 'react';
import { Staff, WorkSite, NormalizedShiftRow } from '../types';
import ImportWizard from './ImportWizard';
import {
  parseStaffCSV,
  parseSiteCSV,
  parseDaysOffCSV,
  downloadStaffTemplate,
  downloadSiteTemplate,
  downloadDaysOffTemplate,
  downloadDaysOffDateTemplate,
  ParseError,
  StaffParseResult,
  SiteParseResult,
  DaysOffRow,
} from '../utils/csvImport';
import { normalizeShiftRow, normalizeSiteIdentity, applySiteNormalize } from '../utils/shiftNormalize';
import { diffImportBatch, ImportDiffResult } from '../utils/importDiff';
import { nextStaffNo } from '../utils/staffUtils';
import { formatSiteLabel } from '../utils/siteUtils';
import {
  parseExcelSiteFile,
  downloadExcelSiteTemplate,
  ExcelSiteParseResult,
} from '../utils/excelImport';

const PASTE_SAMPLE_TEXT =
  `date,siteName,clientName,startTime,endTime,requiredPeople\n` +
  `2026-01-05,札幌駅前,Y!mobile,10:00,18:00,2\n` +
  `2026-01-06,札幌駅前,Y!mobile,10:00,18:00,2`;

// ── Types ────────────────────────────────────────────────────

type DaysOffMode = 'replace' | 'append';

interface DaysOffMatchedRow {
  rowNum: number;
  staffId: string;
  staffNo: string;
  staffName: string;
  matchedBy: 'staffNo' | 'name';
  csvDaysOff: string[];
}

interface DaysOffMatchError {
  rowNum: number;
  staffNo: string;
  name: string;
  message: string;
}

interface DaysOffPreview {
  fileName: string;
  matched: DaysOffMatchedRow[];
  parseErrors: ParseError[];
  matchErrors: DaysOffMatchError[];
}

type StaffPreview = StaffParseResult & { fileName: string };
type SitePreview  = SiteParseResult  & { fileName: string };

// ── ImportBatch ───────────────────────────────────────────────

interface ImportBatch {
  importBatchId: string;
  sourceFileName?: string;
  importedAt?: string;
  venueCount: number;
  siteCount: number;
}

function buildImportBatches(workSites: WorkSite[]): ImportBatch[] {
  const map = new Map<string, { groupIds: Set<string>; count: number; sample: WorkSite }>();
  for (const site of workSites) {
    if (!site.importBatchId || site.isPlaceholder) continue;
    if (!map.has(site.importBatchId)) {
      map.set(site.importBatchId, { groupIds: new Set(), count: 0, sample: site });
    }
    const entry = map.get(site.importBatchId)!;
    entry.count++;
    if (site.groupId) entry.groupIds.add(site.groupId);
  }
  return [...map.entries()]
    .map(([id, { groupIds, count, sample }]) => ({
      importBatchId: id,
      sourceFileName: sample.sourceFileName,
      importedAt:     sample.importedAt,
      venueCount:     groupIds.size,
      siteCount:      count,
    }))
    .sort((a, b) => (b.importedAt ?? '').localeCompare(a.importedAt ?? ''));
}

function formatImportedAt(iso: string): string {
  try {
    const d = new Date(iso);
    const y  = d.getFullYear();
    const mo = String(d.getMonth() + 1).padStart(2, '0');
    const dy = String(d.getDate()).padStart(2, '0');
    const h  = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    return `${y}-${mo}-${dy} ${h}:${mi}`;
  } catch {
    return iso;
  }
}

// ── Props ─────────────────────────────────────────────────────

interface Props {
  staff: Staff[];
  workSites: WorkSite[];
  currentSiteCount: number;
  csvSiteCount: number;
  onImportStaff: (imported: Staff[]) => void;
  onImportSites: (imported: WorkSite[], overwrite: boolean) => void;
  onApplyDaysOff: (updates: { id: string; requestedDaysOff: string[] }[]) => void;
  onDeleteCsvSites: () => void;
  onDeleteImportBatch: (importBatchId: string) => void;
  onReimportBatch: (oldBatchId: string, newSites: WorkSite[]) => void;
  selectedMonth: string;
}

// ── Sub-components ────────────────────────────────────────────

const ERROR_DISPLAY_LIMIT = 10;

function ErrorList({ errors }: { errors: ParseError[] }) {
  if (errors.length === 0) return null;
  const shown = errors.slice(0, ERROR_DISPLAY_LIMIT);
  const remaining = errors.length - shown.length;
  return (
    <div className="import-errors">
      <div className="import-errors__title">エラー {errors.length}件（該当行はスキップされます）</div>
      {shown.map((err, i) => (
        <div key={i} className="import-error-row">
          {err.row}行目：{err.message}
        </div>
      ))}
      {remaining > 0 && (
        <div className="import-error-row import-error-row--more">他 {remaining}件…</div>
      )}
    </div>
  );
}

function DiffSummary({ diff }: { diff: ImportDiffResult }) {
  const total = diff.addedCount + diff.removedCount + diff.updatedCount + diff.unchangedCount;
  return (
    <div className="reimport-diff">
      <div className="reimport-diff__title">変更内容プレビュー（日単位）</div>
      <div className="reimport-diff__rows">
        {diff.addedCount > 0 && (
          <span className="reimport-diff__badge reimport-diff__badge--added">
            追加 {diff.addedCount}日
          </span>
        )}
        {diff.removedCount > 0 && (
          <span className="reimport-diff__badge reimport-diff__badge--removed">
            削除 {diff.removedCount}日
          </span>
        )}
        {diff.updatedCount > 0 && (
          <span className="reimport-diff__badge reimport-diff__badge--updated">
            変更 {diff.updatedCount}日
          </span>
        )}
        <span className="reimport-diff__badge reimport-diff__badge--unchanged">
          変更なし {diff.unchangedCount}日
        </span>
        <span className="reimport-diff__total">→ 合計 {total}日</span>
      </div>
      <p className="wiz-hint">確定すると旧バッチが削除され、新データが登録されます。手動データは保護されます。</p>
    </div>
  );
}

// ── ImportBatchCard ────────────────────────────────────────────

function ImportBatchCard({
  workSites,
  onDeleteBatch,
  onStartReimport,
}: {
  workSites: WorkSite[];
  onDeleteBatch: (batchId: string) => void;
  onStartReimport: (batch: ImportBatch) => void;
}) {
  const batches = buildImportBatches(workSites);
  if (batches.length === 0) return null;
  return (
    <div className="card">
      <h3>インポート履歴</h3>
      <p className="section-desc">
        取り込み済みデータをバッチ単位で確認・再インポート・削除できます。
        手動で作成・編集したデータは削除・上書きされません。
      </p>
      <div className="import-batch-list">
        {batches.map((batch) => (
          <div key={batch.importBatchId} className="import-batch-row">
            <div className="import-batch-row__info">
              <span className="import-batch-row__file">
                {batch.sourceFileName ?? '（ファイル名不明）'}
              </span>
              <span className="import-batch-row__meta">
                {batch.importedAt ? formatImportedAt(batch.importedAt) : '日時不明'}
                　{batch.venueCount}会場・{batch.siteCount}日分
              </span>
            </div>
            <div className="import-batch-row__actions">
              <button
                className="btn btn--ghost btn--sm"
                onClick={() => onStartReimport(batch)}
              >
                再インポート
              </button>
              <button
                className="btn btn--danger btn--sm"
                onClick={() => {
                  const label = batch.sourceFileName ?? 'このバッチ';
                  if (window.confirm(
                    `「${label}」の取り込みデータ（${batch.venueCount}会場・${batch.siteCount}日分）を削除します。\n` +
                    `手動で作成・編集したデータは削除されません。\n` +
                    `この操作は元に戻せません。よろしいですか？`
                  )) {
                    onDeleteBatch(batch.importBatchId);
                  }
                }}
              >
                削除
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────

function parseSiteDate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function countImportSessions(sites: WorkSite[]): { sessionCount: number; venueCount: number } {
  const bySiteKey = new Map<string, WorkSite[]>();
  for (const site of sites) {
    const key = site.normalizedSiteKey ?? normalizeSiteIdentity(site.siteName, site.clientName);
    if (!bySiteKey.has(key)) bySiteKey.set(key, []);
    bySiteKey.get(key)!.push(site);
  }
  let sessionCount = 0;
  for (const [, group] of bySiteKey) {
    const sorted = [...group].sort((a, b) => a.date.localeCompare(b.date));
    sessionCount++;
    let prev = sorted[0];
    for (let i = 1; i < sorted.length; i++) {
      const cur = sorted[i];
      const sameSettings =
        cur.startTime === prev.startTime &&
        cur.endTime   === prev.endTime;
      const dayDiff = Math.round(
        (parseSiteDate(cur.date).getTime() - parseSiteDate(prev.date).getTime()) / 86400000
      );
      if (!sameSettings || dayDiff !== 1) sessionCount++;
      prev = cur;
    }
  }
  return { sessionCount, venueCount: bySiteKey.size };
}

function matchDaysOffRows(
  rows: DaysOffRow[],
  staff: Staff[]
): { matched: DaysOffMatchedRow[]; matchErrors: DaysOffMatchError[] } {
  const byStaffNo: Record<string, Staff> = {};
  const byName: Record<string, Staff> = {};
  staff.forEach((s) => {
    if (s.staffNo) byStaffNo[s.staffNo] = s;
    byName[s.name] = s;
  });

  const matched: DaysOffMatchedRow[] = [];
  const matchErrors: DaysOffMatchError[] = [];

  for (const row of rows) {
    let found: Staff | undefined;
    let matchedBy: DaysOffMatchedRow['matchedBy'] = 'staffNo';

    if (row.staffNo) {
      found = byStaffNo[row.staffNo];
      matchedBy = 'staffNo';
    }
    if (!found && row.name) {
      found = byName[row.name];
      matchedBy = 'name';
    }

    if (!found) {
      matchErrors.push({
        rowNum: row.rowNum,
        staffNo: row.staffNo,
        name: row.name,
        message: row.staffNo
          ? `スタッフNo「${row.staffNo}」が見つかりません`
          : `名前「${row.name}」が見つかりません`,
      });
    } else {
      matched.push({
        rowNum: row.rowNum,
        staffId: found.id,
        staffNo: found.staffNo,
        staffName: found.name,
        matchedBy,
        csvDaysOff: row.requestedDaysOff,
      });
    }
  }

  return { matched, matchErrors };
}

function computeMerged(
  existing: string[],
  csvDaysOff: string[],
  mode: DaysOffMode,
  targetMonth: string
): string[] {
  if (mode === 'replace') {
    const csvInMonth = csvDaysOff.filter((d) => d.startsWith(targetMonth));
    const existingOther = existing.filter((d) => !d.startsWith(targetMonth));
    return [...existingOther, ...csvInMonth].sort();
  }
  return [...new Set([...existing, ...csvDaysOff])].sort();
}

// ── Main Component ─────────────────────────────────────────────

export default function CsvImporter({
  staff,
  workSites,
  currentSiteCount,
  csvSiteCount,
  onImportStaff,
  onImportSites,
  onApplyDaysOff,
  onDeleteCsvSites,
  onDeleteImportBatch,
  onReimportBatch,
  selectedMonth,
}: Props) {
  const [staffPreview,   setStaffPreview]   = useState<StaffPreview | null>(null);
  const [sitePreview,    setSitePreview]    = useState<SitePreview  | null>(null);
  const [daysOffPreview, setDaysOffPreview] = useState<DaysOffPreview | null>(null);

  const [staffSuccess,   setStaffSuccess]   = useState('');
  const [siteSuccess,    setSiteSuccess]    = useState('');
  const [daysOffSuccess, setDaysOffSuccess] = useState('');

  const [pasteSiteText,    setPasteSiteText]    = useState('');
  const [pasteSitePreview, setPasteSitePreview] = useState<SiteParseResult | null>(null);
  const [pasteSiteSuccess, setPasteSiteSuccess] = useState('');
  const [pasteCopied,      setPasteCopied]      = useState(false);

  const [daysOffTargetMonth, setDaysOffTargetMonth] = useState(() => selectedMonth);
  const [daysOffMode,        setDaysOffMode]        = useState<DaysOffMode>('replace');
  const [overwriteMode,      setOverwriteMode]      = useState(false);

  // 再インポート状態
  const [reimportBatch,    setReimportBatch]    = useState<ImportBatch | null>(null);
  const [reimportFileName, setReimportFileName] = useState('');
  const [reimportSites,    setReimportSites]    = useState<WorkSite[] | null>(null);
  const [reimportDiff,     setReimportDiff]     = useState<ImportDiffResult | null>(null);
  const [reimportLoading,  setReimportLoading]  = useState(false);

  useEffect(() => {
    setDaysOffTargetMonth(selectedMonth);
  }, [selectedMonth]);

  const sitePreviewCounts = useMemo(
    () => sitePreview ? countImportSessions(sitePreview.valid) : { sessionCount: 0, venueCount: 0 },
    [sitePreview]
  );
  const pasteSitePreviewCounts = useMemo(
    () => pasteSitePreview ? countImportSessions(pasteSitePreview.valid) : { sessionCount: 0, venueCount: 0 },
    [pasteSitePreview]
  );
  const pasteNormalizedRows = useMemo<NormalizedShiftRow[]>(
    () => pasteSitePreview?.valid.map((s) => normalizeShiftRow(s)) ?? [],
    [pasteSitePreview]
  );

  const [excelPreview,   setExcelPreview]   = useState<ExcelSiteParseResult | null>(null);
  const [excelSuccess,   setExcelSuccess]   = useState('');
  const [excelFileName,  setExcelFileName]  = useState('');
  const [excelLoading,   setExcelLoading]   = useState(false);

  const staffInputRef   = useRef<HTMLInputElement>(null);
  const siteInputRef    = useRef<HTMLInputElement>(null);
  const daysOffInputRef = useRef<HTMLInputElement>(null);
  const excelInputRef   = useRef<HTMLInputElement>(null);
  const reimportFileRef = useRef<HTMLInputElement>(null);

  // ── File readers ────────────────────────────────────────────

  function readFile(file: File, onLoad: (text: string, name: string) => void) {
    const reader = new FileReader();
    reader.onload = (e) => onLoad((e.target?.result ?? '') as string, file.name);
    reader.readAsText(file, 'UTF-8');
  }

  function handleStaffFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    readFile(file, (text, fileName) => {
      setStaffPreview({ ...parseStaffCSV(text), fileName });
      setStaffSuccess('');
    });
  }

  function handleSiteFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    readFile(file, (text, fileName) => {
      setSitePreview({ ...parseSiteCSV(text), fileName });
      setSiteSuccess('');
    });
  }

  function handleDaysOffFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    readFile(file, (text, fileName) => {
      const parsed = parseDaysOffCSV(text, daysOffTargetMonth);
      const { matched, matchErrors } = matchDaysOffRows(parsed.rows, staff);
      setDaysOffPreview({ fileName, matched, parseErrors: parsed.errors, matchErrors });
      setDaysOffSuccess('');
    });
  }

  async function handleExcelFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setExcelLoading(true);
    setExcelFileName(file.name);
    setExcelSuccess('');
    try {
      const result = await parseExcelSiteFile(file);
      setExcelPreview(result);
    } finally {
      setExcelLoading(false);
    }
  }

  // ── Clear handlers ───────────────────────────────────────────

  function clearStaffPreview() {
    setStaffPreview(null);
    if (staffInputRef.current) staffInputRef.current.value = '';
  }

  function clearSitePreview() {
    setSitePreview(null);
    if (siteInputRef.current) siteInputRef.current.value = '';
  }

  function clearDaysOffPreview() {
    setDaysOffPreview(null);
    if (daysOffInputRef.current) daysOffInputRef.current.value = '';
  }

  function clearExcelPreview() {
    setExcelPreview(null);
    setExcelFileName('');
    if (excelInputRef.current) excelInputRef.current.value = '';
  }

  // ── buildSiteGroups (純関数: groupId / sessionId / バッチ情報を付与) ──

  function buildSiteGroups(
    validSites: WorkSite[],
    sourceFileName?: string,
  ): { sites: WorkSite[]; venueCount: number; sessionCount: number } {
    const now           = new Date();
    const importBatchId = crypto.randomUUID();
    const importedAt    = now.toISOString();
    const pad = (n: number) => String(n).padStart(2, '0');
    const importLabel = `CSV取込：${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;

    const normalizedSites = validSites.map(applySiteNormalize);

    const bySiteKey = new Map<string, WorkSite[]>();
    for (const site of normalizedSites) {
      const key = site.normalizedSiteKey ?? normalizeSiteIdentity(site.siteName, site.clientName);
      if (!bySiteKey.has(key)) bySiteKey.set(key, []);
      bySiteKey.get(key)!.push(site);
    }

    const withGroup: WorkSite[] = [];
    let sessionCount = 0;

    for (const [, siteGroup] of bySiteKey) {
      const groupId = crypto.randomUUID();
      const { siteName, clientName } = siteGroup[0];
      const venueLabel = formatSiteLabel(siteName, clientName);
      const sorted = [...siteGroup].sort((a, b) => a.date.localeCompare(b.date));

      let currentSessionId = crypto.randomUUID();
      sessionCount++;
      let prev = sorted[0];
      withGroup.push({
        ...prev,
        groupId,
        groupLabel: `${venueLabel}：${importLabel}`,
        sessionId: currentSessionId,
        importBatchId,
        importedAt,
        ...(sourceFileName ? { sourceFileName } : {}),
      });

      for (let i = 1; i < sorted.length; i++) {
        const cur = sorted[i];
        const sameSettings = cur.startTime === prev.startTime && cur.endTime === prev.endTime;
        const dayDiff = Math.round(
          (parseSiteDate(cur.date).getTime() - parseSiteDate(prev.date).getTime()) / 86400000
        );
        if (!sameSettings || dayDiff !== 1) {
          currentSessionId = crypto.randomUUID();
          sessionCount++;
        }
        withGroup.push({
          ...cur,
          groupId,
          groupLabel: `${venueLabel}：${importLabel}`,
          sessionId: currentSessionId,
          importBatchId,
          importedAt,
          ...(sourceFileName ? { sourceFileName } : {}),
        });
        prev = cur;
      }
    }

    return { sites: withGroup, venueCount: bySiteKey.size, sessionCount };
  }

  // ── Import / apply handlers ──────────────────────────────────

  function handleImportStaff() {
    if (!staffPreview?.valid.length) return;
    let nextNo = parseInt(nextStaffNo(staff), 10);
    const withNos = staffPreview.valid.map((s) => ({
      ...s,
      staffNo: s.staffNo || String(nextNo++),
    }));
    const count = withNos.length;
    onImportStaff(withNos);
    clearStaffPreview();
    setStaffSuccess(`${count}件のスタッフを追加しました（合計 ${staff.length + count}件）`);
    setTimeout(() => setStaffSuccess(''), 5000);
  }

  function applySiteImport(
    validSites: WorkSite[],
    sourceFileName?: string,
  ): { venueCount: number; sessionCount: number } {
    const { sites, venueCount, sessionCount } = buildSiteGroups(validSites, sourceFileName);
    onImportSites(sites, overwriteMode);
    return { venueCount, sessionCount };
  }

  function handleImportSites() {
    if (!sitePreview?.valid.length) return;
    const { venueCount, sessionCount } = applySiteImport(sitePreview.valid, sitePreview.fileName);
    clearSitePreview();
    const modeLabel = overwriteMode ? '（既存CSVデータを置換）' : '';
    setSiteSuccess(`${venueCount}現場・${sessionCount}会期を追加しました${modeLabel}`);
    setTimeout(() => setSiteSuccess(''), 5000);
  }

  function handleCopySample() {
    navigator.clipboard.writeText(PASTE_SAMPLE_TEXT).then(() => {
      setPasteCopied(true);
      setTimeout(() => setPasteCopied(false), 2000);
    });
  }

  function clearPasteSiteText() {
    setPasteSiteText('');
    setPasteSitePreview(null);
  }

  function handleImportPasteSites() {
    if (!pasteSitePreview?.valid.length) return;
    const { venueCount, sessionCount } = applySiteImport(pasteSitePreview.valid, 'CSV貼り付け');
    clearPasteSiteText();
    const modeLabel = overwriteMode ? '（既存CSVデータを置換）' : '';
    setPasteSiteSuccess(`${venueCount}現場・${sessionCount}会期を追加しました${modeLabel}`);
    setTimeout(() => setPasteSiteSuccess(''), 5000);
  }

  function handleImportExcel() {
    if (!excelPreview?.valid.length) return;
    const { venueCount, sessionCount } = applySiteImport(excelPreview.valid, excelFileName);
    clearExcelPreview();
    const modeLabel = overwriteMode ? '（既存CSVデータを置換）' : '';
    setExcelSuccess(`${venueCount}現場・${sessionCount}会期を追加しました${modeLabel}`);
    setTimeout(() => setExcelSuccess(''), 5000);
  }

  function handleApplyDaysOff() {
    if (!daysOffPreview?.matched.length) return;
    const updates = daysOffPreview.matched.map(({ staffId, csvDaysOff }) => {
      const existing = staff.find((s) => s.id === staffId)?.requestedDaysOff ?? [];
      return {
        id: staffId,
        requestedDaysOff: computeMerged(existing, csvDaysOff, daysOffMode, daysOffTargetMonth),
      };
    });
    const count = updates.length;
    onApplyDaysOff(updates);
    clearDaysOffPreview();
    setDaysOffSuccess(`${count}件のスタッフの希望休を更新しました`);
    setTimeout(() => setDaysOffSuccess(''), 5000);
  }

  // ── 再インポートハンドラ ──────────────────────────────────────

  function handleStartReimport(batch: ImportBatch) {
    setReimportBatch(batch);
    setReimportSites(null);
    setReimportDiff(null);
    setReimportFileName('');
  }

  function handleCancelReimport() {
    setReimportBatch(null);
    setReimportSites(null);
    setReimportDiff(null);
    setReimportFileName('');
    if (reimportFileRef.current) reimportFileRef.current.value = '';
  }

  async function handleReimportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !reimportBatch) return;
    setReimportLoading(true);
    try {
      let rawSites: WorkSite[];
      if (file.name.toLowerCase().endsWith('.xlsx')) {
        const result = await parseExcelSiteFile(file);
        rawSites = result.valid;
      } else {
        const text = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload  = (ev) => resolve((ev.target?.result ?? '') as string);
          reader.onerror = () => reject(new Error('読み込みに失敗しました'));
          reader.readAsText(file, 'UTF-8');
        });
        rawSites = parseSiteCSV(text).valid;
      }
      const oldSites = workSites.filter((s) => s.importBatchId === reimportBatch.importBatchId);
      const diff = diffImportBatch(oldSites, rawSites);
      setReimportSites(rawSites);
      setReimportDiff(diff);
      setReimportFileName(file.name);
    } finally {
      setReimportLoading(false);
      if (reimportFileRef.current) reimportFileRef.current.value = '';
    }
  }

  function handleConfirmReimport() {
    if (!reimportBatch || !reimportSites) return;
    const { sites, venueCount, sessionCount } = buildSiteGroups(reimportSites, reimportFileName);
    onReimportBatch(reimportBatch.importBatchId, sites);
    setSiteSuccess(`再インポート完了：${venueCount}会場・${sessionCount}会期`);
    setTimeout(() => setSiteSuccess(''), 5000);
    handleCancelReimport();
  }

  // ── Render ────────────────────────────────────────────────────

  return (
    <div>
      <h2>インポート</h2>

      {/* ── 会期リストインポートウィザード ──────────────── */}
      <ImportWizard existingWorkSites={workSites} onImportSites={onImportSites} />

      {/* ── インポート履歴 ────────────────────────────────── */}
      <ImportBatchCard
        workSites={workSites}
        onDeleteBatch={onDeleteImportBatch}
        onStartReimport={handleStartReimport}
      />

      {/* ── 再インポートパネル ────────────────────────────── */}
      {reimportBatch && (
        <div className="card reimport-panel">
          <h3>再インポート</h3>
          <p className="section-desc">
            「{reimportBatch.sourceFileName ?? reimportBatch.importBatchId}」
            （{reimportBatch.venueCount}会場・{reimportBatch.siteCount}日分）を
            新しいファイルで置き換えます。
          </p>

          {/* フェーズ1: ファイル選択 */}
          <div className="import-upload">
            <input
              type="file"
              accept=".csv,.xlsx"
              id="reimport-file-input"
              ref={reimportFileRef}
              className="file-input-hidden"
              onChange={handleReimportFile}
              disabled={reimportLoading}
            />
            <label htmlFor="reimport-file-input" className="btn btn--secondary">
              {reimportLoading ? '読込中…' : (reimportSites ? '別ファイルを選択' : '新しいファイルを選択（CSV / Excel）')}
            </label>
            <button className="btn btn--ghost" onClick={handleCancelReimport}>
              キャンセル
            </button>
          </div>

          {/* フェーズ2: 差分プレビューと確認 */}
          {reimportSites && reimportDiff && (
            <>
              <div className="import-preview__filename">
                ファイル：{reimportFileName}　{reimportSites.length}件
              </div>
              <DiffSummary diff={reimportDiff} />
              <div className="import-actions">
                <span className="import-actions__label">
                  この内容で置き換えます
                </span>
                <div className="import-actions__buttons">
                  <button className="btn btn--primary" onClick={handleConfirmReimport}>
                    置き換える
                  </button>
                  <button className="btn btn--secondary" onClick={handleCancelReimport}>
                    キャンセル
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {/* ── スタッフCSV ─────────────────────────────────── */}
      <div className="card">
        <h3>スタッフCSVのインポート</h3>
        <p className="section-desc">
          テンプレートをダウンロードしてスタッフ情報を入力後、CSVファイルを選択してください。
        </p>

        <div className="import-upload">
          <input
            type="file"
            accept=".csv"
            id="staff-csv-input"
            ref={staffInputRef}
            className="file-input-hidden"
            onChange={handleStaffFile}
          />
          <label htmlFor="staff-csv-input" className="btn btn--secondary">
            CSVファイルを選択
          </label>
          <button className="btn btn--ghost" onClick={downloadStaffTemplate}>
            テンプレートをダウンロード
          </button>
          <span className="import-current">現在 {staff.length}件登録済み</span>
        </div>

        {staffPreview && (
          <div className="import-preview">
            <div className="import-preview__filename">ファイル：{staffPreview.fileName}</div>
            <div className="import-summary">
              <span className="import-summary__ok">取込可能：{staffPreview.valid.length}件</span>
              {staffPreview.errors.length > 0 && (
                <span className="import-summary__err">エラー：{staffPreview.errors.length}行スキップ</span>
              )}
            </div>
            <ErrorList errors={staffPreview.errors} />
            {staffPreview.valid.length > 0 ? (
              <>
                <div className="table-wrapper">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>名前</th>
                        <th>勤務可能曜日</th>
                        <th>希望休</th>
                        <th>最大日数</th>
                        <th>メモ</th>
                      </tr>
                    </thead>
                    <tbody>
                      {staffPreview.valid.map((s, i) => (
                        <tr key={i}>
                          <td>{s.name}</td>
                          <td>{s.availableWeekdays.join('・')}</td>
                          <td>{s.requestedDaysOff.join(', ') || '—'}</td>
                          <td>{s.maxWorkDays}日</td>
                          <td>{s.memo || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="import-actions">
                  <span className="import-actions__label">
                    {staffPreview.valid.length}件のスタッフ
                  </span>
                  <div className="import-actions__buttons">
                    <button className="btn btn--primary" onClick={handleImportStaff}>追加する</button>
                    <button className="btn btn--secondary" onClick={clearStaffPreview}>キャンセル</button>
                  </div>
                </div>
              </>
            ) : (
              <p className="import-no-valid">取り込める有効なデータがありません</p>
            )}
          </div>
        )}

        {staffSuccess && <div className="success-msg">{staffSuccess}</div>}
      </div>

      {/* ── 現場CSV ──────────────────────────────────────── */}
      <div className="card">
        <h3>現場CSVのインポート</h3>
        <p className="section-desc">
          テンプレートをダウンロードして現場・会期・必要人数を入力後、CSVファイルを選択してください。
        </p>

        <div className="import-upload">
          <input
            type="file"
            accept=".csv"
            id="site-csv-input"
            ref={siteInputRef}
            className="file-input-hidden"
            onChange={handleSiteFile}
          />
          <label htmlFor="site-csv-input" className="btn btn--secondary">
            CSVファイルを選択
          </label>
          <button className="btn btn--ghost" onClick={downloadSiteTemplate}>
            テンプレートをダウンロード
          </button>
          <span className="import-current">現在 {currentSiteCount}件登録済み</span>
        </div>

        <div className="import-overwrite">
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={overwriteMode}
              onChange={(e) => setOverwriteMode(e.target.checked)}
            />
            上書きモード（CSV/Excelデータを置換）
          </label>
          {overwriteMode && (
            <span className="import-overwrite__note">
              取り込み時に既存のインポート済み現場
              {csvSiteCount > 0 ? `（${csvSiteCount}件）` : ''}
              をすべて削除してから登録します（手動作成データは保護されます）
            </span>
          )}
        </div>

        {csvSiteCount > 0 && (
          <div className="import-danger-zone">
            <span className="import-current">インポート済み {csvSiteCount}件</span>
            <button
              className="btn btn--danger btn--sm"
              onClick={() => {
                if (window.confirm(
                  `インポート済み現場を全件削除します（${csvSiteCount}件）。\n` +
                  `手動で作成・編集した現場は削除されません。\n` +
                  `この操作は元に戻せません。よろしいですか？`
                )) {
                  onDeleteCsvSites();
                  setSiteSuccess(`インポート済み現場 ${csvSiteCount}件を削除しました`);
                  setTimeout(() => setSiteSuccess(''), 5000);
                }
              }}
            >
              インポート済み現場を全削除
            </button>
          </div>
        )}

        {sitePreview && (
          <div className="import-preview">
            <div className="import-preview__filename">ファイル：{sitePreview.fileName}</div>
            <div className="import-summary">
              <span className="import-summary__ok">取込可能：{sitePreview.valid.length}行</span>
              {sitePreview.errors.length > 0 && (
                <span className="import-summary__err">エラー：{sitePreview.errors.length}行スキップ</span>
              )}
            </div>
            <ErrorList errors={sitePreview.errors} />
            {sitePreview.valid.length > 0 ? (
              <>
                <div className="table-wrapper">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>日付</th>
                        <th>現場名</th>
                        <th>クライアント名</th>
                        <th>開始</th>
                        <th>終了</th>
                        <th>必要人数</th>
                        <th>メモ</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sitePreview.valid.map((s, i) => (
                        <tr key={i}>
                          <td>{s.date}</td>
                          <td>{s.siteName}</td>
                          <td>{s.clientName?.trim() || '—'}</td>
                          <td>{s.startTime}</td>
                          <td>{s.endTime}</td>
                          <td>{s.requiredPeople}人</td>
                          <td>{s.memo || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="import-actions">
                  <span className="import-actions__label">
                    {sitePreviewCounts.venueCount}現場・{sitePreviewCounts.sessionCount}会期
                  </span>
                  <div className="import-actions__buttons">
                    <button className="btn btn--primary" onClick={handleImportSites}>追加する</button>
                    <button className="btn btn--secondary" onClick={clearSitePreview}>キャンセル</button>
                  </div>
                </div>
              </>
            ) : (
              <p className="import-no-valid">取り込める有効なデータがありません</p>
            )}
          </div>
        )}

        {siteSuccess && <div className="success-msg">{siteSuccess}</div>}
      </div>

      {/* ── 現場CSV テキスト貼り付け ────────────────────────── */}
      <div className="card">
        <h3>現場CSV テキスト貼り付け</h3>
        <p className="section-desc">CSVを貼り付けるだけで取り込めます</p>

        <textarea
          className="paste-textarea"
          rows={7}
          value={pasteSiteText}
          onChange={(e) => {
            const text = e.target.value;
            setPasteSiteText(text);
            if (text.trim()) {
              setPasteSitePreview(parseSiteCSV(text));
            } else {
              setPasteSitePreview(null);
            }
          }}
          placeholder={'ここにCSVを貼り付け'}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
        />

        <div className="paste-helper">
          <button className="btn btn--ghost btn--sm" onClick={handleCopySample}>
            {pasteCopied ? 'コピーしました ✓' : 'サンプルをコピー'}
          </button>
          <details className="paste-details">
            <summary className="paste-details__summary">フォーマット例を見る</summary>
            <div className="paste-details__body">
              <pre className="paste-sample__code">{PASTE_SAMPLE_TEXT}</pre>
              <button
                className="btn btn--ghost btn--sm"
                style={{ marginBottom: 10 }}
                onClick={() => {
                  setPasteSiteText(PASTE_SAMPLE_TEXT);
                  setPasteSitePreview(parseSiteCSV(PASTE_SAMPLE_TEXT));
                }}
              >
                テキストエリアに貼り付ける
              </button>
              <ul className="paste-format-notes">
                <li>1行目はヘッダー行が必要です</li>
                <li>列順：<code>date, siteName, clientName, startTime, endTime, requiredPeople</code></li>
                <li>ChatGPT等で生成したCSVをそのまま貼り付けできます</li>
                <li>文字コードは UTF-8 推奨（BOM付き可）</li>
              </ul>
            </div>
          </details>
        </div>

        {pasteSitePreview && (
          <div className="import-preview">
            <div className="import-summary">
              <span className="import-summary__ok">解析OK：{pasteNormalizedRows.length}行</span>
              {pasteSitePreview.errors.length > 0 && (
                <span className="import-summary__err">エラー：{pasteSitePreview.errors.length}行スキップ</span>
              )}
            </div>
            <ErrorList errors={pasteSitePreview.errors} />
            {pasteNormalizedRows.length > 0 ? (
              <>
                <div className="table-wrapper">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>日付</th>
                        <th>現場名</th>
                        <th>クライアント名</th>
                        <th>開始</th>
                        <th>終了</th>
                        <th>必要人数</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pasteNormalizedRows.map((r, i) => (
                        <tr key={i}>
                          <td>{r.date}</td>
                          <td>{r.siteName}</td>
                          <td>{r.clientName ?? '—'}</td>
                          <td>{r.startTime}</td>
                          <td>{r.endTime}</td>
                          <td>{r.requiredPeople}人</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="import-actions">
                  <span className="import-actions__label">
                    {pasteSitePreviewCounts.venueCount}現場・{pasteSitePreviewCounts.sessionCount}会期
                    {overwriteMode && <span className="days-off-mode-badge">上書きモード</span>}
                  </span>
                  <div className="import-actions__buttons">
                    <button className="btn btn--primary" onClick={handleImportPasteSites}>追加する</button>
                    <button className="btn btn--secondary" onClick={clearPasteSiteText}>クリア</button>
                  </div>
                </div>
              </>
            ) : (
              <p className="import-no-valid">取り込める有効なデータがありません</p>
            )}
          </div>
        )}

        {pasteSiteSuccess && <div className="success-msg">{pasteSiteSuccess}</div>}
      </div>

      {/* ── 現場Excel ────────────────────────────────────────── */}
      <div className="card">
        <h3>現場Excelのインポート</h3>
        <p className="section-desc">
          Excelテンプレートをダウンロードして現場・会期を入力後、.xlsxファイルを選択してください。
        </p>

        <div className="import-upload">
          <input
            type="file"
            accept=".xlsx"
            id="site-excel-input"
            ref={excelInputRef}
            className="file-input-hidden"
            onChange={handleExcelFile}
          />
          <label htmlFor="site-excel-input" className="btn btn--secondary">
            {excelLoading ? '読込中…' : 'Excelファイルを選択'}
          </label>
          <button
            className="btn btn--ghost"
            onClick={() => downloadExcelSiteTemplate()}
          >
            テンプレートをダウンロード
          </button>
          <span className="import-current">現在 {currentSiteCount}件登録済み</span>
        </div>

        {excelPreview && (
          <div className="import-preview">
            <div className="import-preview__filename">ファイル：{excelFileName}</div>
            <div className="import-summary">
              <span className="import-summary__ok">
                取込可能：{excelPreview.sessions.length}会期（{excelPreview.valid.length}日分）
              </span>
              {excelPreview.errors.length > 0 && (
                <span className="import-summary__err">
                  エラー：{excelPreview.errors.length}行スキップ
                </span>
              )}
            </div>
            <ErrorList errors={excelPreview.errors} />
            {excelPreview.sessions.length > 0 ? (
              <>
                <div className="table-wrapper">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>クライアント</th>
                        <th>現場名</th>
                        <th>サブ会場名</th>
                        <th>開始日</th>
                        <th>終了日</th>
                        <th>時間</th>
                        <th>必要人数</th>
                        <th>メモ</th>
                      </tr>
                    </thead>
                    <tbody>
                      {excelPreview.sessions.map((s, i) => (
                        <tr key={i}>
                          <td>{s.clientName || '—'}</td>
                          <td>{s.siteName}</td>
                          <td>{s.subSiteName || '—'}</td>
                          <td>{s.startDate}</td>
                          <td>{s.endDate}</td>
                          <td>{s.startTime}〜{s.endTime}</td>
                          <td>{s.requiredPeople}人</td>
                          <td>{s.memo || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="import-actions">
                  <span className="import-actions__label">
                    {excelPreview.sessions.length}会期・{excelPreview.valid.length}日分
                    {overwriteMode && <span className="days-off-mode-badge">上書きモード</span>}
                  </span>
                  <div className="import-actions__buttons">
                    <button className="btn btn--primary" onClick={handleImportExcel}>追加する</button>
                    <button className="btn btn--secondary" onClick={clearExcelPreview}>キャンセル</button>
                  </div>
                </div>
              </>
            ) : (
              <p className="import-no-valid">取り込める有効なデータがありません</p>
            )}
          </div>
        )}

        {excelSuccess && <div className="success-msg">{excelSuccess}</div>}
      </div>

      {/* ── 希望休CSV ─────────────────────────────────────── */}
      <div className="card">
        <h3>希望休CSVのインポート</h3>
        <p className="section-desc">
          テンプレートをダウンロードして希望休を入力後、CSVファイルを選択してください。
        </p>

        <div className="days-off-options">
          <div className="form-row">
            <label className="form-label">対象月</label>
            <input
              type="month"
              className="form-input form-input--short"
              value={daysOffTargetMonth}
              onChange={(e) => setDaysOffTargetMonth(e.target.value)}
            />
          </div>
          <div className="form-row">
            <label className="form-label">取込モード</label>
            <div className="radio-group">
              <label className="radio-label">
                <input
                  type="radio"
                  name="daysOffMode"
                  value="replace"
                  checked={daysOffMode === 'replace'}
                  onChange={() => setDaysOffMode('replace')}
                />
                対象月だけ置き換え
              </label>
              <label className="radio-label">
                <input
                  type="radio"
                  name="daysOffMode"
                  value="append"
                  checked={daysOffMode === 'append'}
                  onChange={() => setDaysOffMode('append')}
                />
                既存に追加
              </label>
            </div>
          </div>
        </div>

        <div className="import-upload">
          <input
            type="file"
            accept=".csv"
            id="days-off-csv-input"
            ref={daysOffInputRef}
            className="file-input-hidden"
            onChange={handleDaysOffFile}
          />
          <label htmlFor="days-off-csv-input" className="btn btn--secondary">
            CSVファイルを選択
          </label>
          <button className="btn btn--ghost" onClick={downloadDaysOffTemplate}>
            テンプレート①（一括）
          </button>
          <button className="btn btn--ghost" onClick={downloadDaysOffDateTemplate}>
            テンプレート②（1行1日付）
          </button>
        </div>

        {daysOffPreview && (
          <div className="import-preview">
            <div className="import-preview__filename">ファイル：{daysOffPreview.fileName}</div>
            <div className="import-summary">
              <span className="import-summary__ok">照合成功：{daysOffPreview.matched.length}名</span>
              {(daysOffPreview.parseErrors.length + daysOffPreview.matchErrors.length) > 0 && (
                <span className="import-summary__err">
                  エラー：{daysOffPreview.parseErrors.length + daysOffPreview.matchErrors.length}件
                </span>
              )}
            </div>

            <ErrorList errors={daysOffPreview.parseErrors} />

            {daysOffPreview.matchErrors.length > 0 && (() => {
              const shown = daysOffPreview.matchErrors.slice(0, ERROR_DISPLAY_LIMIT);
              const remaining = daysOffPreview.matchErrors.length - shown.length;
              return (
                <div className="import-errors">
                  <div className="import-errors__title">
                    照合エラー {daysOffPreview.matchErrors.length}件（該当行はスキップされます）
                  </div>
                  {shown.map((err, i) => (
                    <div key={i} className="import-error-row">
                      {err.rowNum}行目：{err.message}
                    </div>
                  ))}
                  {remaining > 0 && (
                    <div className="import-error-row import-error-row--more">他 {remaining}件…</div>
                  )}
                </div>
              );
            })()}

            {daysOffPreview.matched.length > 0 ? (
              <>
                <div className="table-wrapper">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>No.</th>
                        <th>名前</th>
                        <th>照合</th>
                        <th>CSV希望休</th>
                        <th>反映後（対象月）</th>
                      </tr>
                    </thead>
                    <tbody>
                      {daysOffPreview.matched.map((m) => {
                        const existing =
                          staff.find((s) => s.id === m.staffId)?.requestedDaysOff ?? [];
                        const merged = computeMerged(
                          existing,
                          m.csvDaysOff,
                          daysOffMode,
                          daysOffTargetMonth
                        );
                        const afterMonth = merged.filter((d) =>
                          d.startsWith(daysOffTargetMonth)
                        );
                        return (
                          <tr key={`${m.staffId}-${m.rowNum}`}>
                            <td>{m.staffNo || '—'}</td>
                            <td>{m.staffName}</td>
                            <td>
                              <span className={`match-badge match-badge--${m.matchedBy}`}>
                                {m.matchedBy === 'staffNo' ? 'No.' : '名前'}
                              </span>
                            </td>
                            <td className="days-off-cell">
                              {m.csvDaysOff.length > 0
                                ? m.csvDaysOff.map((d) => d.slice(5)).join(', ')
                                : '—'}
                            </td>
                            <td className="days-off-cell">
                              {afterMonth.length > 0
                                ? afterMonth.map((d) => d.slice(8)).join(', ')
                                : '—'}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <div className="import-actions">
                  <span className="import-actions__label">
                    {daysOffPreview.matched.length}名・
                    {daysOffPreview.matched.reduce((sum, m) => {
                      const dates = daysOffMode === 'replace'
                        ? m.csvDaysOff.filter((d) => d.startsWith(daysOffTargetMonth))
                        : m.csvDaysOff;
                      return sum + dates.length;
                    }, 0)}件の希望休
                    <span className="days-off-mode-badge">
                      {daysOffMode === 'replace' ? `${daysOffTargetMonth} を置き換え` : '既存に追加'}
                    </span>
                  </span>
                  <div className="import-actions__buttons">
                    <button className="btn btn--primary" onClick={handleApplyDaysOff}>反映する</button>
                    <button className="btn btn--secondary" onClick={clearDaysOffPreview}>キャンセル</button>
                  </div>
                </div>
              </>
            ) : (
              <p className="import-no-valid">
                {daysOffPreview.parseErrors.length === 0 &&
                daysOffPreview.matchErrors.length === 0
                  ? '取り込める有効なデータがありません'
                  : '照合できるデータがありません'}
              </p>
            )}
          </div>
        )}

        {daysOffSuccess && <div className="success-msg">{daysOffSuccess}</div>}
      </div>
    </div>
  );
}
