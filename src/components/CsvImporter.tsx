import { useRef, useState } from 'react';
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
  onImportSites: (imported: WorkSite[]) => void;
  onApplyDaysOff: (updates: { id: string; requestedDaysOff: string[] }[]) => void;
  onDeleteCsvSites: () => void;
}

// ── Sub-components ────────────────────────────────────────────

function ErrorList({ errors }: { errors: ParseError[] }) {
  if (errors.length === 0) return null;
  return (
    <div className="import-errors">
      <div className="import-errors__title">エラー {errors.length}件（該当行はスキップされます）</div>
      {errors.map((err, i) => (
        <div key={i} className="import-error-row">
          {err.row}行目：{err.message}
        </div>
      ))}
    </div>
  );
}

function ImportCount({ count, suffix = '件を取り込みます' }: { count: number; suffix?: string }) {
  return (
    <div className="import-count">
      <span className="import-count__num">{count}</span>{suffix}
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────

function toYearMonth(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
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
}: Props) {
  const [staffPreview,   setStaffPreview]   = useState<StaffPreview | null>(null);
  const [sitePreview,    setSitePreview]    = useState<SitePreview  | null>(null);
  const [daysOffPreview, setDaysOffPreview] = useState<DaysOffPreview | null>(null);

  const [staffSuccess,   setStaffSuccess]   = useState('');
  const [siteSuccess,    setSiteSuccess]    = useState('');
  const [daysOffSuccess, setDaysOffSuccess] = useState('');

  const [daysOffTargetMonth, setDaysOffTargetMonth] = useState(() => toYearMonth(new Date()));
  const [daysOffMode,        setDaysOffMode]        = useState<DaysOffMode>('replace');

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
      const parsed = parseDaysOffCSV(text);
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
    const groupId = crypto.randomUUID();
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const groupLabel = `CSV取込：${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
    // 集約済みの各 WorkSite に一意の sessionId を付与。
    // sessionId がないと WorkSiteManager が fallback のギャップ検出を使い
    // 同一日が別会期として表示されるため必須。
    const withGroup = sitePreview.valid.map((s) => ({
      ...s,
      groupId,
      groupLabel,
      sessionId: crypto.randomUUID(),
    }));
    const count = withGroup.length;
    onImportSites(withGroup);
    clearSitePreview();
    setSiteSuccess(`${count}会期の現場を追加しました（合計 ${currentSiteCount + count}件）`);
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
          スタッフ情報をCSVファイルから一括で取り込めます。既存のスタッフは消えずに追加されます。
        </p>

        <div className="import-format">
          <div className="import-format__title">CSVフォーマット（文字コード：UTF-8）</div>
          <pre className="import-format__code">{`name,availableWeekdays,requestedDaysOff,maxWorkDays,memo
佐藤太郎,"月,火,水,木,金","2026-05-03,2026-05-10",20,リーダー可
田中花子,"月,水,金",,15,`}</pre>
        </div>

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
            <ErrorList errors={staffPreview.errors} />
            {staffPreview.valid.length > 0 ? (
              <>
                <ImportCount count={staffPreview.valid.length} />
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
                  <button className="btn btn--primary" onClick={handleImportStaff}>
                    {staffPreview.valid.length}件を追加する
                  </button>
                  <button className="btn btn--secondary" onClick={clearStaffPreview}>
                    キャンセル
                  </button>
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
          現場情報をCSVファイルから一括で取り込めます。既存の現場は消えずに追加されます。
          取り込んだ現場はグループなしで個別登録されます。
        </p>

        <div className="import-format">
          <div className="import-format__title">CSVフォーマット（文字コード：UTF-8）</div>
          <pre className="import-format__code">{`date,siteName,startTime,endTime,requiredPeople,memo
2026-05-01,アリオ札幌,10:00,18:00,3,通常
2026-05-02,南郷7丁目,09:00,17:00,2,`}</pre>
        </div>

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
            <ErrorList errors={sitePreview.errors} />
            {sitePreview.valid.length > 0 ? (
              <>
                <ImportCount count={sitePreview.valid.length} suffix="会期（集約済み）を取り込みます" />
                <div className="table-wrapper">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>日付</th>
                        <th>現場名</th>
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
                  <button className="btn btn--primary" onClick={handleImportSites}>
                    {sitePreview.valid.length}会期を追加する
                  </button>
                  <button className="btn btn--secondary" onClick={clearSitePreview}>
                    キャンセル
                  </button>
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
          スタッフが申請した希望休をCSVから取り込み、各スタッフのシフト除外日に反映します。
          スタッフNoを優先キーとして照合し、空の場合は名前で照合します。
        </p>

        <div className="import-format">
          <div className="import-format__title">対応CSVフォーマット（文字コード：UTF-8 / ヘッダーは省略可）</div>
          <div className="import-format__subtitle">① 1スタッフ1行（一括形式）</div>
          <pre className="import-format__code">{`staffNo,name,requestedDaysOff
001,セトケンスケ,"2026-05-03,2026-05-10,2026-05-18"
002,マツハシマミ,"2026-05-01,2026-05-07"`}</pre>
          <div className="import-format__subtitle">② 1希望休1行（Bubble等の外部フォーム出力）</div>
          <pre className="import-format__code">{`staffNo,name,date
001,セトケンスケ,2026-05-03
001,セトケンスケ,2026-05-10
002,マツハシマミ,2026-05-01`}</pre>
          <div className="import-format__note">staffNo列がない場合は name,date の2列でも可。同一スタッフの行は自動集約されます。</div>
        </div>

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

            <ErrorList errors={daysOffPreview.parseErrors} />

            {daysOffPreview.matchErrors.length > 0 && (
              <div className="import-errors">
                <div className="import-errors__title">
                  照合エラー {daysOffPreview.matchErrors.length}件（該当行はスキップされます）
                </div>
                {daysOffPreview.matchErrors.map((err, i) => (
                  <div key={i} className="import-error-row">
                    {err.rowNum}行目：{err.message}
                  </div>
                ))}
              </div>
            )}

            {daysOffPreview.matched.length > 0 ? (
              <>
                {(() => {
                  const totalDates = daysOffPreview.matched.reduce((sum, m) => {
                    const dates =
                      daysOffMode === 'replace'
                        ? m.csvDaysOff.filter((d) => d.startsWith(daysOffTargetMonth))
                        : m.csvDaysOff;
                    return sum + dates.length;
                  }, 0);
                  return (
                    <div className="import-count">
                      <span className="import-count__num">{daysOffPreview.matched.length}</span>
                      名・
                      <span className="import-count__num">{totalDates}</span>
                      件の希望休を反映します
                      <span className="days-off-mode-badge">
                        {daysOffMode === 'replace'
                          ? `${daysOffTargetMonth} を置き換え`
                          : '既存に追加'}
                      </span>
                    </div>
                  );
                })()}
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
                  <button className="btn btn--primary" onClick={handleApplyDaysOff}>
                    {daysOffPreview.matched.length}件に反映する
                  </button>
                  <button className="btn btn--secondary" onClick={clearDaysOffPreview}>
                    キャンセル
                  </button>
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
