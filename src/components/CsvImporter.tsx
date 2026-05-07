import { useRef, useState, useMemo, useEffect } from 'react';
import { Staff, WorkSite } from '../types';
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
import { nextStaffNo } from '../utils/staffUtils';

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

// ── Props ─────────────────────────────────────────────────────

interface Props {
  staff: Staff[];
  currentSiteCount: number;
  csvSiteCount: number;
  onImportStaff: (imported: Staff[]) => void;
  onImportSites: (imported: WorkSite[], overwrite: boolean) => void;
  onApplyDaysOff: (updates: { id: string; requestedDaysOff: string[] }[]) => void;
  onDeleteCsvSites: () => void;
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

// ── Helpers ───────────────────────────────────────────────────

// YYYY-MM-DD をローカル日付として解釈（UTC midnight ずれ回避）
function parseSiteDate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

// 連続日 + 同一時間帯でグルーピングしたときの会期数・現場数を返す（プレビュー表示用）
function countImportSessions(sites: WorkSite[]): { sessionCount: number; venueCount: number } {
  const bySiteName = new Map<string, WorkSite[]>();
  for (const site of sites) {
    if (!bySiteName.has(site.siteName)) bySiteName.set(site.siteName, []);
    bySiteName.get(site.siteName)!.push(site);
  }
  let sessionCount = 0;
  for (const [, group] of bySiteName) {
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
  return { sessionCount, venueCount: bySiteName.size };
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
  currentSiteCount,
  csvSiteCount,
  onImportStaff,
  onImportSites,
  onApplyDaysOff,
  onDeleteCsvSites,
  selectedMonth,
}: Props) {
  const [staffPreview,   setStaffPreview]   = useState<StaffPreview | null>(null);
  const [sitePreview,    setSitePreview]    = useState<SitePreview  | null>(null);
  const [daysOffPreview, setDaysOffPreview] = useState<DaysOffPreview | null>(null);

  const [staffSuccess,   setStaffSuccess]   = useState('');
  const [siteSuccess,    setSiteSuccess]    = useState('');
  const [daysOffSuccess, setDaysOffSuccess] = useState('');

  const [daysOffTargetMonth, setDaysOffTargetMonth] = useState(() => selectedMonth);
  const [daysOffMode,        setDaysOffMode]        = useState<DaysOffMode>('replace');
  const [overwriteMode,      setOverwriteMode]      = useState(false);

  useEffect(() => {
    setDaysOffTargetMonth(selectedMonth);
  }, [selectedMonth]);

  // 連続日結合後の会期数・現場数（プレビュー表示用）
  const sitePreviewCounts = useMemo(
    () => sitePreview ? countImportSessions(sitePreview.valid) : { sessionCount: 0, venueCount: 0 },
    [sitePreview]
  );

  const staffInputRef   = useRef<HTMLInputElement>(null);
  const siteInputRef    = useRef<HTMLInputElement>(null);
  const daysOffInputRef = useRef<HTMLInputElement>(null);

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

  function handleImportSites() {
    if (!sitePreview?.valid.length) return;
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const importLabel = `CSV取込：${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;

    // siteName ごとに groupId を管理
    const groupIdBySiteName = new Map<string, string>();
    // siteName ごとに分類して日付順に並べる
    const bySiteName = new Map<string, WorkSite[]>();
    for (const site of sitePreview.valid) {
      if (!bySiteName.has(site.siteName)) bySiteName.set(site.siteName, []);
      bySiteName.get(site.siteName)!.push(site);
    }

    const withGroup: WorkSite[] = [];
    let sessionCount = 0;

    for (const [siteName, siteGroup] of bySiteName) {
      const groupId = crypto.randomUUID();
      groupIdBySiteName.set(siteName, groupId);
      const sorted = [...siteGroup].sort((a, b) => a.date.localeCompare(b.date));

      // 連続日 + 同一時間帯 → 同じ sessionId にまとめる（requiredPeople は無視）
      let currentSessionId = crypto.randomUUID();
      sessionCount++;
      let prev = sorted[0];
      withGroup.push({
        ...prev,
        groupId,
        groupLabel: `${siteName}：${importLabel}`,
        sessionId: currentSessionId,
      });

      for (let i = 1; i < sorted.length; i++) {
        const cur = sorted[i];
        const sameSettings =
          cur.startTime === prev.startTime &&
          cur.endTime   === prev.endTime;
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
          groupLabel: `${siteName}：${importLabel}`,
          sessionId: currentSessionId,
        });
        prev = cur;
      }
    }

    const venueCount = groupIdBySiteName.size;
    onImportSites(withGroup, overwriteMode);
    clearSitePreview();
    const modeLabel = overwriteMode ? '（既存CSVデータを置換）' : '';
    setSiteSuccess(`${venueCount}現場・${sessionCount}会期を追加しました${modeLabel}`);
    setTimeout(() => setSiteSuccess(''), 5000);
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

  // ── Render ────────────────────────────────────────────────────

  return (
    <div>
      <h2>CSVインポート</h2>

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
            上書きモード（CSVデータを置換）
          </label>
          {overwriteMode && (
            <span className="import-overwrite__note">
              取り込み時に既存のCSV取込済み現場
              {csvSiteCount > 0 ? `（${csvSiteCount}件）` : ''}
              をすべて削除してから登録します
            </span>
          )}
        </div>

        {csvSiteCount > 0 && (
          <div className="import-danger-zone">
            <span className="import-current">CSV取込済み {csvSiteCount}件</span>
            <button
              className="btn btn--danger btn--sm"
              onClick={() => {
                if (window.confirm('インポート済み現場をすべて削除します。よろしいですか？')) {
                  onDeleteCsvSites();
                  setSiteSuccess(`CSV取込済みの現場 ${csvSiteCount}件を削除しました`);
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
