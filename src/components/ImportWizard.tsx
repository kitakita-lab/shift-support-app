import { useState, useRef } from 'react';
import { WorkSite, ImportLog } from '../types';
import {
  RawSheet,
  ColumnMapping,
  MappingKey,
  MAPPING_LABELS,
  REQUIRED_MAPPING_KEYS,
  ParsedSessionRow,
  readRawCsv,
  readRawExcel,
  autoDetectMapping,
  applyMapping,
} from '../utils/rawImport';
import { applySiteNormalize, buildSiteIdentityKey, cleanSiteName } from '../utils/shiftNormalize';

// ── Types ─────────────────────────────────────────────────────

interface ExistingGroup {
  groupId:          string;
  siteName:         string;
  subSiteName?:     string;
  clientName?:      string;
  siteIdentityKey?: string;
}

interface ExistingVenueCandidate extends ExistingGroup {
  score:           number;
  /** clientName が片方だけ空で一致が不確かな場合 true */
  isLowConfidence: boolean;
}

interface VenueDecision {
  rawKey:         string;
  rawSiteName:    string;
  subSiteNameRaw: string;
  clientName:     string;
  sessionCount:   number;
  candidates:     ExistingVenueCandidate[];
  /** siteIdentityKey が完全一致した既存グループ。null = 重複なし */
  exactDuplicate: ExistingGroup | null;
  /**
   * null = まだ未確定（ユーザーが選択していない）
   * 'new'      = 新規会場として登録
   * 'existing' = 既存会場に紐付け
   * 'skip'     = 取り込まない
   */
  choice:
    | { kind: 'new';      siteName: string; subSiteName: string }
    | { kind: 'existing'; groupId: string; siteName: string; subSiteName: string }
    | { kind: 'skip' }
    | null;
}

type WizardStep = 'file' | 'columns' | 'venues';

interface Props {
  existingWorkSites: WorkSite[];
  onImportSites: (imported: WorkSite[], overwrite: boolean) => void;
  onAddImportLog?: (log: ImportLog) => void;
}

// ── Helpers ───────────────────────────────────────────────────

function simpleNorm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[Ａ-Ｚ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[ａ-ｚ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[\s　（）()]/g, '');
}

function bigramSim(a: string, b: string): number {
  if (!a || !b) return 0;
  const bigrams = (s: string) => {
    const set = new Set<string>();
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
    return set;
  };
  const ba = bigrams(a);
  const bb = bigrams(b);
  if (ba.size === 0 && bb.size === 0) return 1;
  if (ba.size === 0 || bb.size === 0) return 0;
  let intersection = 0;
  for (const bg of ba) { if (bb.has(bg)) intersection++; }
  return (2 * intersection) / (ba.size + bb.size);
}

// 類似度閾値。低すぎると「イオン苗穂」と「イオン発寒」のような別会場が候補に出る。
// 正規化一致は強制スコア 1.0 なので完全一致は必ず候補に出る。
const CANDIDATE_THRESHOLD = 0.7;

function findCandidates(
  rawSiteName:    string,
  subSiteNameRaw: string,
  clientName:     string,
  groups:         ExistingGroup[],
): ExistingVenueCandidate[] {
  // rawSiteName にはクリーニング前の汚染文字列が含まれる可能性があるため
  // cleanSiteName を適用してから類似度を計算する
  const cleaned    = cleanSiteName(rawSiteName);
  const normRaw    = simpleNorm(cleaned + subSiteNameRaw);
  const hasClient  = clientName.trim() !== '';

  const results: ExistingVenueCandidate[] = [];
  for (const g of groups) {
    const gHasClient = (g.clientName?.trim() ?? '') !== '';

    // clientName が両方存在して不一致 → 別クライアントの同名会場なので候補に出さない
    if (hasClient && gHasClient && clientName.trim() !== (g.clientName ?? '').trim()) continue;

    // 片方だけ空 → 一致が不確かなため低信頼候補として扱う
    const isLowConfidence = hasClient !== gHasClient;

    const normGroup = simpleNorm(g.siteName + (g.subSiteName ?? ''));
    const score = normRaw === normGroup ? 1.0 : bigramSim(normRaw, normGroup);
    if (score < CANDIDATE_THRESHOLD) continue;

    results.push({ ...g, score, isLowConfidence });
  }
  return results.sort((a, b) => b.score - a.score).slice(0, 3);
}

/**
 * インポート候補行から siteIdentityKey を事前計算する。
 * applySiteNormalize と同じロジックを適用して、既存データとの照合に使う。
 */
function computeIncomingIdentityKey(
  rawSiteName:    string,
  subSiteNameRaw: string,
  clientName:     string,
): string {
  const cleaned         = cleanSiteName(rawSiteName);
  const m               = cleaned.match(/[（(]([^）)]+)[）)]$/);
  const extractedClient = m ? m[1].trim() : undefined;
  const resolvedClient  = clientName.trim() || extractedClient || undefined;
  const siteNameFinal   = m ? cleaned.replace(/[（(][^）)]+[）)]$/, '').trim() : cleaned;
  const subSite         = subSiteNameRaw.trim() || undefined;
  return buildSiteIdentityKey(siteNameFinal, subSite, resolvedClient);
}

function getExistingGroups(workSites: WorkSite[]): ExistingGroup[] {
  const seen = new Map<string, ExistingGroup>();
  for (const site of workSites) {
    if (!site.groupId || site.isPlaceholder) continue;
    if (!seen.has(site.groupId)) {
      seen.set(site.groupId, {
        groupId:          site.groupId,
        siteName:         site.siteName,
        subSiteName:      site.subSiteName,
        clientName:       site.clientName,
        siteIdentityKey:  site.siteIdentityKey,
      });
    }
  }
  return [...seen.values()];
}

function buildVenueDecisions(
  parsedRows: ParsedSessionRow[],
  groups:     ExistingGroup[],
): VenueDecision[] {
  // siteIdentityKey → ExistingGroup の高速ルックアップマップ
  const identityMap = new Map<string, ExistingGroup>();
  for (const g of groups) {
    if (g.siteIdentityKey) identityMap.set(g.siteIdentityKey, g);
  }

  const seen = new Map<string, VenueDecision>();
  for (const row of parsedRows) {
    if (row.errors.length > 0) continue;
    const rawKey = `${row.rawSiteName}\0${row.subSiteNameRaw}`;
    if (seen.has(rawKey)) {
      seen.get(rawKey)!.sessionCount++;
      continue;
    }

    const incomingKey    = computeIncomingIdentityKey(row.rawSiteName, row.subSiteNameRaw, row.clientName);
    const exactDuplicate = identityMap.get(incomingKey) ?? null;
    const candidates     = findCandidates(row.rawSiteName, row.subSiteNameRaw, row.clientName, groups);

    // 重複がある場合はデフォルトで「既存に紐付ける」を選択状態にする
    const defaultChoice: VenueDecision['choice'] = exactDuplicate
      ? { kind: 'existing', groupId: exactDuplicate.groupId, siteName: exactDuplicate.siteName, subSiteName: exactDuplicate.subSiteName ?? '' }
      : { kind: 'new',      siteName: row.rawSiteName, subSiteName: row.subSiteNameRaw };

    seen.set(rawKey, {
      rawKey,
      rawSiteName:    row.rawSiteName,
      subSiteNameRaw: row.subSiteNameRaw,
      clientName:     row.clientName,
      sessionCount:   1,
      candidates,
      exactDuplicate,
      choice:         defaultChoice,
    });
  }
  return [...seen.values()];
}

function expandDateRange(startDate: string, endDate: string): string[] {
  if (!startDate) return [];
  if (!endDate || endDate < startDate) return [startDate];
  const dates: string[] = [];
  const [sy, sm, sd] = startDate.split('-').map(Number);
  const [ey, em, ed] = endDate.split('-').map(Number);
  const end = new Date(ey, em - 1, ed);
  for (const d = new Date(sy, sm - 1, sd); d <= end; d.setDate(d.getDate() + 1)) {
    const y  = d.getFullYear();
    const mo = String(d.getMonth() + 1).padStart(2, '0');
    const dy = String(d.getDate()).padStart(2, '0');
    dates.push(`${y}-${mo}-${dy}`);
  }
  return dates;
}

function buildImportSites(
  parsedRows:     ParsedSessionRow[],
  decisions:      VenueDecision[],
  importLabel:    string,
  importBatchId:  string,
  importedAt:     string,
  sourceFileName: string,
): WorkSite[] {
  const decisionMap = new Map<string, VenueDecision>();
  for (const d of decisions) decisionMap.set(d.rawKey, d);

  const result: WorkSite[] = [];
  for (const row of parsedRows) {
    if (row.errors.length > 0) continue;
    const rawKey   = `${row.rawSiteName}\0${row.subSiteNameRaw}`;
    const decision = decisionMap.get(rawKey);
    if (!decision?.choice) continue;
    if (decision.choice.kind === 'skip') continue; // 取り込まない

    const { choice, clientName } = decision;
    const groupId     = choice.kind === 'existing' ? choice.groupId : crypto.randomUUID();
    const siteName    = choice.siteName;
    const subSiteName = choice.subSiteName.trim() || undefined;
    const venuePart   =
      siteName +
      (subSiteName ? `（${subSiteName}）` : '') +
      (clientName?.trim() ? `　${clientName.trim()}` : '');
    const groupLabel  = `${venuePart}：${importLabel}`;
    const sessionId   = crypto.randomUUID();

    for (const date of expandDateRange(row.startDate, row.endDate)) {
      result.push(
        applySiteNormalize({
          id:             crypto.randomUUID(),
          groupId,
          groupLabel,
          sessionId,
          date,
          clientName:     clientName?.trim() || undefined,
          siteName,
          subSiteName,
          rawSiteName:    row.rawSiteName,
          startTime:      row.startTime,
          endTime:        row.endTime,
          requiredPeople: row.requiredPeople ?? 1,
          memo:           row.memo,
          source:         'csv',
          importBatchId,
          importedAt,
          sourceFileName: sourceFileName || undefined,
        }),
      );
    }
  }
  return result;
}

// ── Constants ─────────────────────────────────────────────────

const MAPPING_KEY_ORDER: MappingKey[] = [
  'siteName', 'subSiteName', 'startDate', 'endDate',
  'startTime', 'endTime', 'requiredPeople', 'clientName', 'memo',
];

const EMPTY_MAPPING: ColumnMapping = {
  siteName: null, subSiteName: null, startDate: null, endDate: null,
  startTime: null, endTime: null, requiredPeople: null, clientName: null, memo: null,
};

const WIZARD_STEPS: { key: WizardStep; label: string }[] = [
  { key: 'file',    label: 'ファイル' },
  { key: 'columns', label: '列の確認' },
  { key: 'venues',  label: '会場の確認' },
];

// ── Main component ─────────────────────────────────────────────

export default function ImportWizard({ existingWorkSites, onImportSites, onAddImportLog }: Props) {
  const [step,               setStep]               = useState<WizardStep>('file');
  const [rawSheet,           setRawSheet]           = useState<RawSheet | null>(null);
  const [mapping,            setMapping]            = useState<ColumnMapping>(EMPTY_MAPPING);
  const [fallbackClientName, setFallbackClientName] = useState('');
  const [parsedRows,         setParsedRows]         = useState<ParsedSessionRow[]>([]);
  const [decisions,          setDecisions]          = useState<VenueDecision[]>([]);
  const [fileLoading,        setFileLoading]        = useState(false);
  const [success,            setSuccess]            = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  function reset() {
    setStep('file');
    setRawSheet(null);
    setMapping(EMPTY_MAPPING);
    setFallbackClientName('');
    setParsedRows([]);
    setDecisions([]);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileLoading(true);
    try {
      let sheet: RawSheet;
      if (file.name.toLowerCase().endsWith('.xlsx')) {
        sheet = await readRawExcel(file);
      } else {
        sheet = await new Promise<RawSheet>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload  = (ev) => resolve(readRawCsv((ev.target?.result ?? '') as string, file.name));
          reader.onerror = () => reject(new Error('読み込みに失敗しました'));
          reader.readAsText(file, 'UTF-8');
        });
      }
      setRawSheet(sheet);
      setMapping(autoDetectMapping(sheet.headers));
      setSuccess('');
    } finally {
      setFileLoading(false);
    }
  }

  function handleGoToVenues() {
    if (!rawSheet) return;
    const rows   = applyMapping(rawSheet, mapping, fallbackClientName);
    const groups = getExistingGroups(existingWorkSites);
    setParsedRows(rows);
    setDecisions(buildVenueDecisions(rows, groups));
    setStep('venues');
  }

  function updateDecision(rawKey: string, choice: VenueDecision['choice']) {
    setDecisions((prev) => prev.map((d) => (d.rawKey === rawKey ? { ...d, choice } : d)));
  }

  function updateNewField(rawKey: string, field: 'siteName' | 'subSiteName', value: string) {
    setDecisions((prev) =>
      prev.map((d) => {
        if (d.rawKey !== rawKey || d.choice?.kind !== 'new') return d;
        return { ...d, choice: { ...d.choice, [field]: value } };
      }),
    );
  }

  function handleConfirmNoCandidates() {
    const targets = decisions.filter(
      (d) => d.candidates.length === 0 && !d.exactDuplicate && d.choice?.kind !== 'skip',
    );
    if (targets.length === 0) return;
    if (
      !window.confirm(
        `候補なしの ${targets.length}件を新規会場として確定します。\n` +
        `既存候補・重複・スキップ設定済みは対象外です。\nよろしいですか？`,
      )
    ) return;
    setDecisions((prev) =>
      prev.map((d) => {
        if (d.candidates.length > 0)   return d; // 候補ありは個別確認が必要
        if (d.exactDuplicate)          return d; // 重複ありは個別確認が必要
        if (d.choice?.kind === 'skip') return d; // ユーザーが明示的にスキップした行は保持
        return {
          ...d,
          choice: {
            kind:        'new' as const,
            siteName:    d.choice?.kind === 'new' ? d.choice.siteName    : d.rawSiteName,
            subSiteName: d.choice?.kind === 'new' ? d.choice.subSiteName : d.subSiteNameRaw,
          },
        };
      }),
    );
  }

  function handleImport() {
    const now           = new Date();
    const importBatchId = crypto.randomUUID();
    const importedAt    = now.toISOString();
    const pad = (n: number) => String(n).padStart(2, '0');
    const label =
      `会期リスト取込：${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
      `${pad(now.getHours())}:${pad(now.getMinutes())}`;
    const srcFile  = rawSheet?.fileName ?? '';
    const sites    = buildImportSites(parsedRows, decisions, label, importBatchId, importedAt, srcFile);
    const venueCount = new Set(sites.map((s) => s.groupId)).size;
    onImportSites(sites, false);
    if (onAddImportLog) {
      onAddImportLog({
        id:               crypto.randomUUID(),
        importBatchId,
        source:           rawSheet?.fileName?.endsWith('.xlsx') ? 'excel' : 'csv',
        sourceFileName:   srcFile,
        importedAt,
        rowCount:         parsedRows.filter((r) => r.errors.length === 0).length,
        importedSiteCount: sites.length,
        skippedCount:     skipCount,
        addedCount:       sites.length,
      });
    }
    reset();
    setSuccess(`${venueCount}会場・${sites.length}日分を取り込みました`);
    setTimeout(() => setSuccess(''), 6000);
  }

  const requiredMapped    = REQUIRED_MAPPING_KEYS.every((k) => mapping[k] !== null);
  const allDecided        = decisions.length > 0 && decisions.every((d) => d.choice !== null);
  const validRowCount     = parsedRows.filter((r) => r.errors.length === 0).length;
  const errorRowCount     = parsedRows.filter((r) => r.errors.length > 0).length;
  const noCandidateCount  = decisions.filter(
    (d) => d.candidates.length === 0 && !d.exactDuplicate && d.choice?.kind !== 'skip',
  ).length;
  const hasCandidateCount = decisions.filter((d) => d.candidates.length > 0 && !d.exactDuplicate).length;
  const duplicateCount    = decisions.filter((d) => d.exactDuplicate !== null).length;
  const skipCount         = decisions.filter((d) => d.choice?.kind === 'skip').length;
  // 取り込む（スキップ以外の）行数
  const importableRowCount = parsedRows.filter((r) => {
    if (r.errors.length > 0) return false;
    const key = `${r.rawSiteName}\0${r.subSiteNameRaw}`;
    const dec = decisions.find((d) => d.rawKey === key);
    return dec?.choice?.kind !== 'skip';
  }).length;
  const currentIdx = WIZARD_STEPS.findIndex((s) => s.key === step);

  return (
    <div className="card">
      <h3>会期リストのインポート</h3>
      <p className="section-desc">
        クライアントから受け取った会期リスト（CSV・Excel）を読み込んで、現場データに取り込みます。
      </p>

      {/* ── Step indicator ── */}
      <div className="wiz-steps">
        {WIZARD_STEPS.map(({ key, label }, idx) => {
          const isDone   = idx < currentIdx;
          const isActive = idx === currentIdx;
          return (
            <div
              key={key}
              className={`wiz-step${isActive ? ' wiz-step--active' : ''}${isDone ? ' wiz-step--done' : ''}`}
            >
              <span className="wiz-step__num">{isDone ? '✓' : idx + 1}</span>
              <span className="wiz-step__label">{label}</span>
            </div>
          );
        })}
      </div>

      {/* ── Step 1: File ── */}
      {step === 'file' && (
        <div className="wiz-body">
          <div className="import-upload">
            <input
              type="file"
              accept=".csv,.xlsx"
              id="wiz-file-input"
              ref={fileInputRef}
              className="file-input-hidden"
              onChange={handleFile}
              disabled={fileLoading}
            />
            <label htmlFor="wiz-file-input" className="btn btn--secondary">
              {fileLoading ? '読込中…' : 'ファイルを選択（CSV / Excel）'}
            </label>
          </div>

          {rawSheet && (
            <div className="wiz-file-info">
              <span className="import-summary__ok">
                {rawSheet.fileName}　{rawSheet.headers.length}列・{rawSheet.rows.length}行
              </span>
            </div>
          )}

          <div className="wiz-nav">
            <span />
            <button className="btn btn--primary" onClick={() => setStep('columns')} disabled={!rawSheet}>
              次へ →
            </button>
          </div>
        </div>
      )}

      {/* ── Step 2: Column mapping ── */}
      {step === 'columns' && rawSheet && (
        <div className="wiz-body">
          <div className="form-row">
            <label className="form-label">クライアント名（デフォルト補完）</label>
            <input
              type="text"
              className="form-input form-input--short"
              value={fallbackClientName}
              onChange={(e) => setFallbackClientName(e.target.value)}
              placeholder="例：Y!mobile"
            />
          </div>
          <p className="wiz-hint" style={{ marginTop: 0 }}>
            ※ ファイル内に clientName 列が設定されている場合はその値を優先します。
            未設定または空欄の行のみ、ここで入力した値を補完します。
          </p>

          <div className="table-wrapper" style={{ marginTop: 14 }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>フィールド</th>
                  <th>対応する列</th>
                </tr>
              </thead>
              <tbody>
                {MAPPING_KEY_ORDER.map((key) => {
                  const isRequired = REQUIRED_MAPPING_KEYS.includes(key);
                  return (
                    <tr key={key}>
                      <td>
                        {MAPPING_LABELS[key]}
                        {isRequired && <span className="wiz-required">必須</span>}
                      </td>
                      <td>
                        <select
                          className="form-input"
                          style={{ minWidth: 180 }}
                          value={mapping[key] ?? ''}
                          onChange={(e) => {
                            const val = e.target.value === '' ? null : Number(e.target.value);
                            setMapping((prev) => ({ ...prev, [key]: val }));
                          }}
                        >
                          <option value="">（未設定）</option>
                          {rawSheet.headers.map((h, i) => (
                            <option key={i} value={i}>
                              {i + 1}列目：{h || '（空）'}
                            </option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {!requiredMapped && (
            <p className="wiz-warn">必須フィールドをすべて設定してください</p>
          )}

          <div className="wiz-nav">
            <button className="btn btn--secondary" onClick={() => setStep('file')}>← 戻る</button>
            <button
              className="btn btn--primary"
              onClick={handleGoToVenues}
              disabled={!requiredMapped}
            >
              次へ →
            </button>
          </div>
        </div>
      )}

      {/* ── Step 3: Venue confirmation ── */}
      {step === 'venues' && (
        <div className="wiz-body">
          <div className="import-summary" style={{ marginBottom: 10 }}>
            <span className="import-summary__ok">
              会場 {decisions.length}件・有効行 {validRowCount}行
            </span>
            {duplicateCount > 0 && (
              <span className="wiz-badge wiz-badge--danger" style={{ marginLeft: 8 }}>
                既存と重複 {duplicateCount}件
              </span>
            )}
            {hasCandidateCount > 0 && (
              <span className="wiz-badge wiz-badge--warning" style={{ marginLeft: 8 }}>
                既存候補あり {hasCandidateCount}件
              </span>
            )}
            {skipCount > 0 && (
              <span className="wiz-badge" style={{ marginLeft: 8, background: '#f3f4f6', color: '#6b7280' }}>
                スキップ {skipCount}件
              </span>
            )}
            {errorRowCount > 0 && (
              <span className="import-summary__err">{errorRowCount}行はエラーのためスキップ</span>
            )}
          </div>

          {noCandidateCount > 0 && (
            <div className="wiz-venue-actions">
              <button className="btn btn--ghost btn--sm" onClick={handleConfirmNoCandidates}>
                候補なし {noCandidateCount}件を新規として確定
              </button>
              {(hasCandidateCount > 0 || duplicateCount > 0) && (
                <span className="wiz-hint">
                  ※ 既存候補・重複がある件は個別に選択してください
                </span>
              )}
            </div>
          )}

          <div className="wiz-venue-list">
            {decisions.map((dec) => (
              <VenueDecisionCard
                key={dec.rawKey}
                decision={dec}
                onChoiceChange={(choice) => updateDecision(dec.rawKey, choice)}
                onNameChange={(field, value) => updateNewField(dec.rawKey, field, value)}
              />
            ))}
          </div>

          {decisions.length === 0 && (
            <p className="import-no-valid">取り込める有効なデータがありません</p>
          )}

          <div className="wiz-nav" style={{ marginTop: 16 }}>
            <button className="btn btn--secondary" onClick={() => setStep('columns')}>← 戻る</button>
            <button
              className="btn btn--primary"
              onClick={handleImport}
              disabled={!allDecided || importableRowCount === 0}
            >
              取り込む（{importableRowCount}行）
            </button>
          </div>
        </div>
      )}

      {success && <div className="success-msg">{success}</div>}
    </div>
  );
}

// ── VenueDecisionCard ──────────────────────────────────────────

interface VenueDecisionCardProps {
  decision:       VenueDecision;
  onChoiceChange: (choice: VenueDecision['choice']) => void;
  onNameChange:   (field: 'siteName' | 'subSiteName', value: string) => void;
}

function VenueDecisionCard({ decision, onChoiceChange, onNameChange }: VenueDecisionCardProps) {
  const { exactDuplicate, candidates } = decision;
  const hasDuplicate   = exactDuplicate !== null;
  const hasCandidates  = candidates.length > 0;
  const isNew          = decision.choice?.kind === 'new';
  const isExisting     = decision.choice?.kind === 'existing';
  const isSkip         = decision.choice?.kind === 'skip';

  // 既存紐付けのプルダウン選択肢: exactDuplicate を先頭に、候補（重複除き）を続ける
  const allOptions: (ExistingVenueCandidate | (ExistingGroup & { score: number; isLowConfidence: boolean }))[] = [
    ...(exactDuplicate ? [{ ...exactDuplicate, score: 1.0, isLowConfidence: false }] : []),
    ...candidates.filter((c) => !exactDuplicate || c.groupId !== exactDuplicate.groupId),
  ];

  function handleExistingSelect(groupId: string) {
    const found = allOptions.find((c) => c.groupId === groupId);
    if (found) onChoiceChange({ kind: 'existing', groupId: found.groupId, siteName: found.siteName, subSiteName: found.subSiteName ?? '' });
  }

  const cardClass = [
    'wiz-venue-card',
    hasDuplicate  ? 'wiz-venue-card--duplicate'   : '',
    !hasDuplicate && hasCandidates ? 'wiz-venue-card--candidates' : '',
  ].filter(Boolean).join(' ');

  return (
    <div className={cardClass}>
      <div className="wiz-venue-card__header">
        <div className="wiz-venue-card__name">
          {decision.rawSiteName}
          {decision.subSiteNameRaw && (
            <span className="wiz-venue-card__sub">（{decision.subSiteNameRaw}）</span>
          )}
        </div>
        <div className="wiz-venue-card__meta">
          {decision.clientName && (
            <span className="wiz-venue-card__client">{decision.clientName}</span>
          )}
          <span className="wiz-venue-card__count">{decision.sessionCount}会期</span>
          {hasDuplicate  && <span className="wiz-badge wiz-badge--danger">既存と重複</span>}
          {!hasDuplicate && hasCandidates && <span className="wiz-badge wiz-badge--warning">候補あり</span>}
        </div>
      </div>

      {/* 重複警告バナー */}
      {hasDuplicate && (
        <div className="wiz-duplicate-warning">
          既存データに一致する会場があります。新規登録すると重複します。
          <div className="wiz-duplicate-warning__existing">
            既存：{exactDuplicate.siteName}
            {exactDuplicate.subSiteName ? `（${exactDuplicate.subSiteName}）` : ''}
            {exactDuplicate.clientName  ? `　${exactDuplicate.clientName}`    : ''}
          </div>
        </div>
      )}

      <div className="wiz-venue-card__choices">
        {hasDuplicate ? (
          // ── 重複あり：既存紐付け → 取り込まない → それでも新規 の順で表示 ──
          <>
            <label className="wiz-radio-label">
              <input
                type="radio"
                checked={isExisting}
                onChange={() => handleExistingSelect(exactDuplicate.groupId)}
              />
              既存の会場に紐付ける
            </label>

            {isExisting && decision.choice?.kind === 'existing' && allOptions.length > 0 && (
              <select
                className="form-input"
                value={decision.choice.groupId}
                onChange={(e) => handleExistingSelect(e.target.value)}
              >
                {allOptions.map((c) => (
                  <option key={c.groupId} value={c.groupId}>
                    {c.siteName}
                    {c.subSiteName  ? `（${c.subSiteName}）` : ''}
                    {c.clientName   ? `　${c.clientName}`    : ''}
                    {'score' in c && c.score < 1.0
                      ? `　（類似度 ${Math.round(c.score * 100)}%${'isLowConfidence' in c && c.isLowConfidence ? '・クライアント不明' : ''}）`
                      : '　（完全一致）'}
                  </option>
                ))}
              </select>
            )}

            <label className="wiz-radio-label">
              <input
                type="radio"
                checked={isSkip}
                onChange={() => onChoiceChange({ kind: 'skip' })}
              />
              取り込まない
            </label>

            <label className="wiz-radio-label wiz-radio-label--warning">
              <input
                type="radio"
                checked={isNew}
                onChange={() =>
                  onChoiceChange({ kind: 'new', siteName: decision.rawSiteName, subSiteName: decision.subSiteNameRaw })
                }
              />
              それでも新規登録（重複します）
            </label>

            {isNew && decision.choice?.kind === 'new' && (
              <div className="wiz-venue-card__edit">
                <input
                  type="text"
                  className="form-input"
                  placeholder="会場名"
                  value={decision.choice.siteName}
                  onChange={(e) => onNameChange('siteName', e.target.value)}
                />
                <input
                  type="text"
                  className="form-input"
                  placeholder="サブ会場名（任意）"
                  value={decision.choice.subSiteName}
                  onChange={(e) => onNameChange('subSiteName', e.target.value)}
                />
              </div>
            )}
          </>
        ) : (
          // ── 重複なし：新規 → 既存候補（あれば） → 取り込まない の順 ──
          <>
            <label className="wiz-radio-label">
              <input
                type="radio"
                checked={isNew}
                onChange={() =>
                  onChoiceChange({ kind: 'new', siteName: decision.rawSiteName, subSiteName: decision.subSiteNameRaw })
                }
              />
              新規として登録
            </label>

            {isNew && decision.choice?.kind === 'new' && (
              <div className="wiz-venue-card__edit">
                <input
                  type="text"
                  className="form-input"
                  placeholder="会場名"
                  value={decision.choice.siteName}
                  onChange={(e) => onNameChange('siteName', e.target.value)}
                />
                <input
                  type="text"
                  className="form-input"
                  placeholder="サブ会場名（任意）"
                  value={decision.choice.subSiteName}
                  onChange={(e) => onNameChange('subSiteName', e.target.value)}
                />
              </div>
            )}

            {hasCandidates && (
              <>
                <label className="wiz-radio-label">
                  <input
                    type="radio"
                    checked={isExisting}
                    onChange={() =>
                      onChoiceChange({
                        kind:        'existing',
                        groupId:     candidates[0].groupId,
                        siteName:    candidates[0].siteName,
                        subSiteName: candidates[0].subSiteName ?? '',
                      })
                    }
                  />
                  既存の会場に紐付け
                </label>

                {isExisting && decision.choice?.kind === 'existing' && (
                  <select
                    className="form-input"
                    value={decision.choice.groupId}
                    onChange={(e) => handleExistingSelect(e.target.value)}
                  >
                    {candidates.map((c) => (
                      <option key={c.groupId} value={c.groupId}>
                        {c.siteName}
                        {c.subSiteName ? `（${c.subSiteName}）` : ''}
                        {c.clientName  ? `　${c.clientName}`    : ''}
                        　（類似度 {Math.round(c.score * 100)}%{c.isLowConfidence ? '・クライアント不明' : ''}）
                      </option>
                    ))}
                  </select>
                )}
              </>
            )}

            <label className="wiz-radio-label">
              <input
                type="radio"
                checked={isSkip}
                onChange={() => onChoiceChange({ kind: 'skip' })}
              />
              取り込まない
            </label>
          </>
        )}
      </div>
    </div>
  );
}
