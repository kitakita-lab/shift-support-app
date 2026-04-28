import { useRef, useState } from 'react';
import { Staff, WorkSite } from '../types';
import {
  parseStaffCSV,
  parseSiteCSV,
  downloadStaffTemplate,
  downloadSiteTemplate,
  ParseError,
  StaffParseResult,
  SiteParseResult,
} from '../utils/csvImport';

interface Props {
  currentStaffCount: number;
  currentSiteCount: number;
  onImportStaff: (imported: Staff[]) => void;
  onImportSites: (imported: WorkSite[]) => void;
}

type StaffPreview  = StaffParseResult & { fileName: string };
type SitePreview   = SiteParseResult  & { fileName: string };

// ── サブコンポーネント ──────────────────────────────────────

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

function ImportCount({ count }: { count: number }) {
  return (
    <div className="import-count">
      <span className="import-count__num">{count}</span>件を取り込みます
    </div>
  );
}

// ── メインコンポーネント ────────────────────────────────────

export default function CsvImporter({
  currentStaffCount,
  currentSiteCount,
  onImportStaff,
  onImportSites,
}: Props) {
  const [staffPreview, setStaffPreview] = useState<StaffPreview | null>(null);
  const [sitePreview,  setSitePreview]  = useState<SitePreview  | null>(null);
  const [staffSuccess, setStaffSuccess] = useState('');
  const [siteSuccess,  setSiteSuccess]  = useState('');

  const staffInputRef = useRef<HTMLInputElement>(null);
  const siteInputRef  = useRef<HTMLInputElement>(null);

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

  function clearStaffPreview() {
    setStaffPreview(null);
    if (staffInputRef.current) staffInputRef.current.value = '';
  }

  function clearSitePreview() {
    setSitePreview(null);
    if (siteInputRef.current) siteInputRef.current.value = '';
  }

  function handleImportStaff() {
    if (!staffPreview?.valid.length) return;
    const count = staffPreview.valid.length;
    onImportStaff(staffPreview.valid);
    clearStaffPreview();
    setStaffSuccess(`${count}件のスタッフを追加しました（合計 ${currentStaffCount + count}件）`);
    setTimeout(() => setStaffSuccess(''), 5000);
  }

  function handleImportSites() {
    if (!sitePreview?.valid.length) return;
    const groupId = crypto.randomUUID();
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const groupLabel = `CSV取込：${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
    const withGroup = sitePreview.valid.map((s) => ({ ...s, groupId, groupLabel }));
    const count = withGroup.length;
    onImportSites(withGroup);
    clearSitePreview();
    setSiteSuccess(`${count}件の現場を追加しました（合計 ${currentSiteCount + count}件）`);
    setTimeout(() => setSiteSuccess(''), 5000);
  }

  return (
    <div>
      <h2>CSVインポート</h2>

      {/* ── スタッフCSV ─────────────────────────────── */}
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
          <span className="import-current">現在 {currentStaffCount}件登録済み</span>
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

      {/* ── 現場CSV ─────────────────────────────────── */}
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

        {sitePreview && (
          <div className="import-preview">
            <div className="import-preview__filename">ファイル：{sitePreview.fileName}</div>

            <ErrorList errors={sitePreview.errors} />

            {sitePreview.valid.length > 0 ? (
              <>
                <ImportCount count={sitePreview.valid.length} />
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
                    {sitePreview.valid.length}件を追加する
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
    </div>
  );
}
