import { useRef, useState, useMemo } from 'react';
import { WorkSite, ImportLog } from '../types';
import { parseSiteCSV, SiteParseResult } from '../utils/csvImport';
import { formatSiteLabel } from '../utils/siteUtils';
import { buildNormalizedSiteKey, normalizeImportedWorkSites } from '../utils/shiftNormalize';
import SessionDateRangePicker from './SessionDateRangePicker';

// ─── ヘルパー関数 ──────────────────────────────────────────

const createId = (): string =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `id-${Date.now()}-${Math.random().toString(36).slice(2)}`;

// YYYY-MM-DD を必ずローカル日付として解釈する。
// new Date("YYYY-MM-DD") は UTC midnight として扱われ timezone で1日ずれるため使用禁止。
function parseDateLocal(s: string): Date {
  const [y, m, d] = s.replace(/\//g, '-').split('-').map(Number);
  return new Date(y, m - 1, d);
}

function calcDateRange(startDate: string, endDate: string): string[] {
  if (!startDate || !endDate || endDate < startDate) return [];
  const pad = (n: number) => n.toString().padStart(2, '0');
  const dates: string[] = [];
  const cursor = parseDateLocal(startDate);
  const end    = parseDateLocal(endDate);
  while (cursor <= end) {
    dates.push(`${cursor.getFullYear()}-${pad(cursor.getMonth() + 1)}-${pad(cursor.getDate())}`);
    cursor.setDate(cursor.getDate() + 1);
  }
  return dates;
}

function calcDayCount(startDate: string, endDate: string): number {
  if (!startDate || !endDate || endDate < startDate) return 0;
  const start = parseDateLocal(startDate);
  const end   = parseDateLocal(endDate);
  return Math.floor((end.getTime() - start.getTime()) / 86400000) + 1;
}

function formatDateShort(dateStr: string): string {
  const d = parseDateLocal(dateStr);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${mm}/${dd}`;
}

function formatDateWithDow(dateStr: string): string {
  const d = parseDateLocal(dateStr);
  const dow = ['日', '月', '火', '水', '木', '金', '土'][d.getDay()];
  return `${formatDateShort(dateStr)}（${dow}）`;
}

// 連続する同一人数の日をまとめて区間配列に変換する
function groupDailyRows(
  rows: { date: string; requiredPeople: number }[]
): { startDate: string; endDate: string; requiredPeople: number }[] {
  if (rows.length === 0) return [];
  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));
  const groups: { startDate: string; endDate: string; requiredPeople: number }[] = [];
  let start = sorted[0];
  let end   = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    const cur     = sorted[i];
    const dayDiff = Math.round(
      (parseDateLocal(cur.date).getTime() - parseDateLocal(end.date).getTime()) / 86400000
    );
    if (cur.requiredPeople === start.requiredPeople && dayDiff === 1) {
      end = cur;
    } else {
      groups.push({ startDate: start.date, endDate: end.date, requiredPeople: start.requiredPeople });
      start = cur;
      end   = cur;
    }
  }
  groups.push({ startDate: start.date, endDate: end.date, requiredPeople: start.requiredPeople });
  return groups;
}

// ─── CSV 取込ヘルパー ─────────────────────────────────────────

function peakColorClass(peak: number, avg: number): 'high' | 'medium' | 'normal' {
  if (peak >= 6 || avg >= 4) return 'high';
  if (peak >= 4 || avg >= 3) return 'medium';
  return 'normal';
}

// 連続日 + 同一時間帯（requiredPeople は無視）でグルーピングしたときの会期数・現場数を返す
// normalizedSiteKey または normalizeSiteIdentity で表記ゆれを吸収したキーを使用
function countImportSessions(sites: WorkSite[]): { sessionCount: number; venueCount: number } {
  const bySiteKey = new Map<string, WorkSite[]>();
  for (const site of sites) {
    // normalizedSiteKey は normalizeImportedWorkSites 後に必ず付与される。
    // フォールバックは subSiteName も含む buildNormalizedSiteKey を使う（normalizeSiteIdentity は subSiteName を無視するため不可）。
    const key = site.normalizedSiteKey ?? buildNormalizedSiteKey(site.siteName, site.subSiteName, site.clientName);
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
      const sameSettings = cur.startTime === prev.startTime && cur.endTime === prev.endTime;
      const dayDiff = Math.round(
        (parseDateLocal(cur.date).getTime() - parseDateLocal(prev.date).getTime()) / 86400000
      );
      if (!sameSettings || dayDiff !== 1) sessionCount++;
      prev = cur;
    }
  }
  return { sessionCount, venueCount: bySiteKey.size };
}

// CSV パース済みデータに normalize + groupId / sessionId を付与して WorkSite[] を返す
// applySiteNormalize で "+N名"・"※..."・括弧クライアント名を処理し、
// normalizeSiteIdentity で表記ゆれ吸収した同一性キーでグループ化する
function buildCsvImportGroups(sites: WorkSite[], sourceFileName?: string): WorkSite[] {
  const now           = new Date();
  const importBatchId = createId();
  const importedAt    = now.toISOString();
  const pad = (n: number) => String(n).padStart(2, '0');
  const importLabel = `CSV取込：${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;

  const normalizedSites = normalizeImportedWorkSites(sites);

  const bySiteKey = new Map<string, WorkSite[]>();
  for (const site of normalizedSites) {
    // applySiteNormalize 後は normalizedSiteKey が保証されているが、型上 optional なので fallback
    // normalizedSiteKey は normalizeImportedWorkSites 後に必ず付与される。
    // フォールバックは subSiteName も含む buildNormalizedSiteKey を使う（normalizeSiteIdentity は subSiteName を無視するため不可）。
    const key = site.normalizedSiteKey ?? buildNormalizedSiteKey(site.siteName, site.subSiteName, site.clientName);
    if (!bySiteKey.has(key)) bySiteKey.set(key, []);
    bySiteKey.get(key)!.push(site);
  }

  const result: WorkSite[] = [];
  for (const [, siteGroup] of bySiteKey) {
    const groupId = createId();
    const { siteName, clientName } = siteGroup[0];
    const venueLabel = formatSiteLabel(siteName, clientName);
    const sorted = [...siteGroup].sort((a, b) => a.date.localeCompare(b.date));
    let currentSessionId = createId();
    let prev = sorted[0];
    result.push({
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
        (parseDateLocal(cur.date).getTime() - parseDateLocal(prev.date).getTime()) / 86400000
      );
      if (!sameSettings || dayDiff !== 1) {
        currentSessionId = createId();
      }
      result.push({
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
  return result;
}

// ─── 重複チェック ──────────────────────────────────────────

function countDuplicateVenues(
  incomingSites: WorkSite[],
  effectiveExisting: WorkSite[],
): { duplicateCount: number; hasManualDuplicate: boolean } {
  const existingKeyToSite = new Map<string, WorkSite>();
  for (const s of effectiveExisting) {
    if (s.siteIdentityKey) existingKeyToSite.set(s.siteIdentityKey, s);
  }
  const checkedKeys = new Set<string>();
  let duplicateCount = 0;
  let hasManualDuplicate = false;
  for (const site of incomingSites) {
    const key = site.siteIdentityKey;
    if (!key || checkedKeys.has(key)) continue;
    checkedKeys.add(key);
    const existing = existingKeyToSite.get(key);
    if (existing) {
      duplicateCount++;
      if (existing.source === 'manual' || existing.isManuallyEdited) hasManualDuplicate = true;
    }
  }
  return { duplicateCount, hasManualDuplicate };
}

// ─── SessionForm (会期) ────────────────────────────────────

interface SessionForm {
  id: string;
  startDate: string;
  endDate: string;
  startTime: string;
  endTime: string;
  requiredPeople: number | '';  // 入力中は空文字を許可。保存時のみ 1 以上に補正する
  memo: string;
}

interface SessionEditorState {
  groupId: string;
  clientName: string;
  siteName: string;
  subSiteName: string;
  sessions: SessionForm[];
  isExistingGroup: boolean;
  sourceIds: string[];
  newSessionIds: string[]; // 今回の編集で追加した会期のID（上部表示・追加中バッジ用）
}

function normalizeRequiredPeople(v: number | ''): number {
  return typeof v === 'number' && v >= 1 ? v : 1;
}

function emptySession(): SessionForm {
  return {
    id: createId(),
    startDate: '',
    endDate: '',
    startTime: '09:00',
    endTime: '18:00',
    requiredPeople: 1,
    memo: '',
  };
}

function deriveSessionsFromSites(sites: WorkSite[]): SessionForm[] {
  const active = sites.filter((s) => !s.isPlaceholder);
  if (active.length === 0) return [emptySession()];

  const hasSessionIds = active.some((s) => s.sessionId);
  if (hasSessionIds) {
    const bySession = new Map<string, WorkSite[]>();
    for (const site of active) {
      const key = site.sessionId ?? `__nosession_${site.date}`;
      if (!bySession.has(key)) bySession.set(key, []);
      bySession.get(key)!.push(site);
    }
    const result: SessionForm[] = [];
    for (const [, group] of bySession) {
      const g = [...group].sort((a, b) => a.date.localeCompare(b.date));
      // Preserve sessionId as the form id so identity stays stable across editor open/save
      result.push({
        id:             g[0].sessionId ?? createId(),
        startDate:      g[0].date,
        endDate:        g[g.length - 1].date,
        startTime:      g[0].startTime,
        endTime:        g[0].endTime,
        requiredPeople: g[0].requiredPeople,
        memo:           g[0].memo,
      });
    }
    return result.sort((a, b) => a.startDate.localeCompare(b.startDate));
  }

  // Fallback: gap detection for legacy records without sessionId
  const sorted = [...active].sort((a, b) => a.date.localeCompare(b.date));
  const sessions: SessionForm[] = [];
  let current: WorkSite[] = [sorted[0]];
  const flushCurrent = () => {
    const g = current;
    sessions.push({
      id:             createId(),
      startDate:      g[0].date,
      endDate:        g[g.length - 1].date,
      startTime:      g[0].startTime,
      endTime:        g[0].endTime,
      requiredPeople: g[0].requiredPeople,
      memo:           g[0].memo,
    });
  };
  for (let i = 1; i < sorted.length; i++) {
    const prev = current[current.length - 1];
    const site = sorted[i];
    const dayDiff = Math.round(
      (parseDateLocal(site.date).getTime() - parseDateLocal(prev.date).getTime()) / 86400000
    );
    const sameSettings =
      prev.startTime === site.startTime &&
      prev.endTime === site.endTime &&
      prev.requiredPeople === site.requiredPeople &&
      prev.memo === site.memo;
    if (sameSettings && dayDiff === 1) {
      current.push(site);
    } else {
      flushCurrent();
      current = [site];
    }
  }
  flushCurrent();
  return sessions;
}

function computeGroupLabel(siteName: string, clientName: string, sessions: SessionForm[]): string {
  const label = formatSiteLabel(siteName, clientName);
  const valid = sessions.filter((s) => s.startDate && s.endDate);
  if (valid.length === 0) return `${label}：会期なし`;
  if (valid.length === 1) return `${label}：${valid[0].startDate}〜${valid[0].endDate}`;
  return `${label}：複数会期`;
}

function buildSessionSites(
  state: SessionEditorState,
  editMeta?: { isManuallyEdited?: boolean; manualEditedAt?: string }
): WorkSite[] {
  const { groupId, clientName, siteName, subSiteName, sessions } = state;
  const subSiteNameVal = subSiteName.trim() || undefined;
  const groupLabel = computeGroupLabel(siteName, clientName, sessions);
  const sites: WorkSite[] = [];
  for (const session of sessions) {
    // Use session.id as sessionId so identity is preserved across edits
    const sessionId = session.id;
    for (const date of calcDateRange(session.startDate, session.endDate)) {
      sites.push({
        id: createId(),
        groupId,
        groupLabel,
        sessionId,
        date,
        clientName,
        siteName,
        subSiteName:    subSiteNameVal,
        startTime:      session.startTime,
        endTime:        session.endTime,
        requiredPeople: normalizeRequiredPeople(session.requiredPeople),
        memo:           session.memo,
        source:         'manual',
        ...editMeta,
      });
    }
  }
  if (sites.length === 0) {
    return [{
      id: createId(), groupId,
      groupLabel: `${formatSiteLabel(siteName, clientName)}：会期なし`,
      date: '', clientName, siteName, subSiteName: subSiteNameVal,
      startTime: '', endTime: '',
      requiredPeople: 0, memo: '',
      isPlaceholder: true,
      source:         'manual',
      ...editMeta,
    }];
  }
  return sites;
}

// ─── DisplaySession (会期表示用) ──────────────────────────────

interface DisplaySession {
  sessionId: string;
  sessionNo: number;
  startDate: string;
  endDate: string;
  startTime: string;
  endTime: string;
  requiredPeople: number;      // 最大値（isUniformPeople が true のときの表示値）
  isUniformPeople: boolean;    // 全日同一人数なら true
  dailyPeople: { date: string; requiredPeople: number }[];  // 日別必要人数
  memo: string;
  dateCount: number;
}

function groupSitesIntoDisplaySessions(sites: WorkSite[]): DisplaySession[] {
  const active = sites.filter((s) => !s.isPlaceholder);
  if (active.length === 0) return [];

  type Proto = Omit<DisplaySession, 'sessionNo'>;

  // ── Phase 1: sessionId ごとにグルーピング ──────────────────────
  const phase1: Proto[] = [];
  const hasSessionIds = active.some((s) => s.sessionId);

  if (hasSessionIds) {
    const bySession = new Map<string, WorkSite[]>();
    for (const site of active) {
      const key = site.sessionId ?? `__nosession_${site.id}`;
      if (!bySession.has(key)) bySession.set(key, []);
      bySession.get(key)!.push(site);
    }
    for (const [key, group] of bySession) {
      const g = [...group].sort((a, b) => a.date.localeCompare(b.date));
      const dailyPeople = g.map((s) => ({ date: s.date, requiredPeople: s.requiredPeople }));
      const maxPeople   = Math.max(...g.map((s) => s.requiredPeople));
      const isUniform   = g.every((s) => s.requiredPeople === g[0].requiredPeople);
      phase1.push({
        sessionId:       g[0].sessionId ?? key,
        startDate:       g[0].date,
        endDate:         g[g.length - 1].date,
        startTime:       g[0].startTime,
        endTime:         g[0].endTime,
        requiredPeople:  maxPeople,
        isUniformPeople: isUniform,
        dailyPeople,
        memo:            g[0].memo,
        dateCount:       g.length,
      });
    }
  } else {
    const sorted = [...active].sort((a, b) => a.date.localeCompare(b.date));
    for (const site of sorted) {
      phase1.push({
        sessionId:       `__nosession_${site.id}`,
        startDate:       site.date,
        endDate:         site.date,
        startTime:       site.startTime,
        endTime:         site.endTime,
        requiredPeople:  site.requiredPeople,
        isUniformPeople: true,
        dailyPeople:     [{ date: site.date, requiredPeople: site.requiredPeople }],
        memo:            site.memo,
        dateCount:       1,
      });
    }
  }

  phase1.sort((a, b) => a.startDate.localeCompare(b.startDate));

  // ── Phase 2: 1日セッションを連続結合 ──────────────────────────
  // 旧 CSV データ（date ごとに個別 sessionId）を連続日 + 同一時間帯でまとめる。
  // requiredPeople が異なっても結合し、日別人数は dailyPeople に保持する。
  // dateCount > 1 の手動作成セッションはそのまま維持する。
  const raw: Proto[] = [];
  if (phase1.length === 0) return [];

  // 結合後に dailyPeople から isUniformPeople / requiredPeople を再計算
  const recompute = (s: Proto): Proto => {
    const peoples = s.dailyPeople.map((d) => d.requiredPeople);
    if (peoples.length === 0) return s;
    return {
      ...s,
      requiredPeople:  Math.max(...peoples),
      isUniformPeople: peoples.every((p) => p === peoples[0]),
    };
  };

  let head    = { ...phase1[0] };
  let merging = head.dateCount === 1;

  for (let i = 1; i < phase1.length; i++) {
    const next = phase1[i];
    const sameSettings =
      head.startTime === next.startTime &&
      head.endTime   === next.endTime;   // requiredPeople は無視して結合
    const dayDiff = Math.round(
      (parseDateLocal(next.startDate).getTime() - parseDateLocal(head.endDate).getTime()) / 86400000
    );
    if (merging && next.dateCount === 1 && sameSettings && dayDiff === 1) {
      head.endDate     = next.endDate;
      head.dateCount++;
      head.dailyPeople = [...head.dailyPeople, ...next.dailyPeople];
    } else {
      raw.push(recompute(head));
      head    = { ...next };
      merging = next.dateCount === 1;
    }
  }
  raw.push(recompute(head));

  return raw
    .sort((a, b) => a.startDate.localeCompare(b.startDate))
    .map((s, i) => ({ ...s, sessionNo: i + 1 }));
}

// ─── Props ─────────────────────────────────────────────────

interface Props {
  workSites: WorkSite[];
  onChange: (workSites: WorkSite[]) => void;
  onAddImportLog: (log: ImportLog) => void;
  selectedMonth: string;
}

// ─── component ─────────────────────────────────────────────

export default function WorkSiteManager({ workSites, onChange, onAddImportLog, selectedMonth }: Props) {
  // ── 新規現場登録フォーム
  const [newClientName,  setNewClientName]  = useState('');
  const [newSiteName,    setNewSiteName]    = useState('');
  const [newSubSiteName, setNewSubSiteName] = useState('');
  const [newSessions,    setNewSessions]    = useState<SessionForm[]>([emptySession()]);
  const [successMsg,     setSuccessMsg]     = useState('');

  // ── 会期エディタ・アコーディオン
  const [sessionEditor,      setSessionEditor]      = useState<SessionEditorState | null>(null);
  const [expandedSessions,   setExpandedSessions]   = useState<Set<string>>(new Set());
  const [expandedVenues,     setExpandedVenues]     = useState<Set<string>>(new Set());
  const [detailedDailyKeys,  setDetailedDailyKeys]  = useState<Set<string>>(new Set());
  // 会期エディタ内でどのセッションカードが展開されているか（IDで管理）
  const [expandedSessionForms, setExpandedSessionForms] = useState<Set<string>>(new Set());
  // 基本情報（クライアント名・現場名）エリアの開閉
  const [siteInfoExpanded,   setSiteInfoExpanded]   = useState(false);

  // ── CSV 取込モーダル
  const [csvModalOpen,      setCsvModalOpen]      = useState(false);
  const [csvModalPreview,   setCsvModalPreview]   = useState<(SiteParseResult & { fileName: string }) | null>(null);
  const [csvModalOverwrite, setCsvModalOverwrite] = useState(false);
  const csvFileRef = useRef<HTMLInputElement>(null);

  // ── 現場検索
  const [siteSearch, setSiteSearch] = useState('');

  // ── 登録プレビュー計算
  const previewCount = useMemo(() =>
    newSessions.reduce((sum, s) => sum + calcDayCount(s.startDate, s.endDate), 0),
  [newSessions]);

  const hasDateError = useMemo(() =>
    newSessions.some((s) => s.startDate && s.endDate && s.endDate < s.startDate),
  [newSessions]);

  const isReady = newSiteName.trim() !== '' && previewCount > 0 && !hasDateError;

  // ── CSV モーダルプレビュー件数
  const csvModalPreviewCounts = useMemo(
    () => csvModalPreview ? countImportSessions(csvModalPreview.valid) : { sessionCount: 0, venueCount: 0 },
    [csvModalPreview]
  );

  // ── グループ化・月優先ソート
  const { sortedGroups, ungroupedSites } = useMemo(() => {
    const grouped: Record<string, WorkSite[]> = {};
    const ungrouped: WorkSite[] = [];
    workSites.forEach((site) => {
      if (site.groupId) (grouped[site.groupId] ??= []).push(site);
      else ungrouped.push(site);
    });
    const groupEntries = Object.entries(grouped)
      .map(([groupId, sites]) => ({
        groupId,
        sites: [...sites].sort((a, b) => a.date.localeCompare(b.date)),
      }))
      .sort((a, b) => {
        const aActive = a.sites.filter((s) => !s.isPlaceholder);
        const bActive = b.sites.filter((s) => !s.isPlaceholder);
        const aMonth  = aActive.filter((s) => s.date.startsWith(selectedMonth));
        const bMonth  = bActive.filter((s) => s.date.startsWith(selectedMonth));
        // 0: 当月あり, 1: 他月のみ, 2: 未登録
        const aPri = aMonth.length > 0 ? 0 : aActive.length > 0 ? 1 : 2;
        const bPri = bMonth.length > 0 ? 0 : bActive.length > 0 ? 1 : 2;
        if (aPri !== bPri) return aPri - bPri;
        const aDate = (aMonth[0] ?? aActive[0])?.date ?? '';
        const bDate = (bMonth[0] ?? bActive[0])?.date ?? '';
        return aDate.localeCompare(bDate);
      });
    return {
      sortedGroups: groupEntries,
      ungroupedSites: [...ungrouped].sort((a, b) => a.date.localeCompare(b.date)),
    };
  }, [workSites, selectedMonth]);

  // ── 検索フィルタ（displaySiteName / rawSiteName / clientName を対象）
  const { filteredGroups, filteredUngrouped } = useMemo(() => {
    const q = siteSearch.trim().toLowerCase();
    if (!q) return { filteredGroups: sortedGroups, filteredUngrouped: ungroupedSites };
    const match = (s: WorkSite) =>
      (s.displaySiteName ?? s.siteName).toLowerCase().includes(q) ||
      s.siteName.toLowerCase().includes(q) ||
      (s.subSiteName ?? '').toLowerCase().includes(q) ||
      (s.clientName ?? '').toLowerCase().includes(q) ||
      (s.rawSiteName ?? '').toLowerCase().includes(q);
    return {
      filteredGroups:    sortedGroups.filter(({ sites }) => sites[0] ? match(sites[0]) : false),
      filteredUngrouped: ungroupedSites.filter(match),
    };
  }, [sortedGroups, ungroupedSites, siteSearch]);

  // ── 新規現場登録 ────────────────────────────────────────────

  function addNewSession() {
    setNewSessions((prev) => [...prev, emptySession()]);
  }

  function removeNewSession(id: string) {
    setNewSessions((prev) => {
      const remaining = prev.filter((s) => s.id !== id);
      return remaining.length > 0 ? remaining : [emptySession()];
    });
  }

  function updateNewSession(id: string, patch: Partial<SessionForm>) {
    setNewSessions((prev) => prev.map((s) => s.id === id ? { ...s, ...patch } : s));
  }

  function handleNewSiteSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!isReady) return;
    const groupId       = createId();
    const groupLabel    = computeGroupLabel(newSiteName, newClientName, newSessions);
    const subSiteNameVal = newSubSiteName.trim() || undefined;
    const rawSites: WorkSite[] = [];
    for (const session of newSessions) {
      const sessionId = session.id;
      for (const date of calcDateRange(session.startDate, session.endDate)) {
        rawSites.push({
          id: createId(),
          groupId,
          groupLabel,
          sessionId,
          date,
          clientName:     newClientName,
          siteName:       newSiteName,
          subSiteName:    subSiteNameVal,
          startTime:      session.startTime,
          endTime:        session.endTime,
          requiredPeople: normalizeRequiredPeople(session.requiredPeople),
          memo:           session.memo,
          source:         'manual',
        });
      }
    }
    // displaySiteName / normalizedSiteKey / siteIdentityKey を手動登録時にも付与する
    const newSites = normalizeImportedWorkSites(rawSites);
    onChange([...workSites, ...newSites]);
    setSuccessMsg(`${newSites.length}件の現場を登録しました`);
    setNewClientName('');
    setNewSiteName('');
    setNewSubSiteName('');
    setNewSessions([emptySession()]);
    setTimeout(() => setSuccessMsg(''), 4000);
  }

  // ── グループ操作 ───────────────────────────────────────────

  function deleteGroup(groupId: string) {
    if (!confirm('この会場（全会期）を削除します。よろしいですか？')) return;
    onChange(workSites.filter((s) => s.groupId !== groupId));
    if (sessionEditor?.groupId === groupId) setSessionEditor(null);
  }

  function deleteSite(id: string) {
    onChange(workSites.filter((s) => s.id !== id));
  }

  function deleteDisplaySession(groupId: string, display: DisplaySession) {
    // 日付範囲 + 時間帯で削除。sessionId が混在する旧 CSV データでも全日分を確実に消す。
    const removed = workSites.filter((s) => {
      if (s.groupId !== groupId) return true;
      if (s.isPlaceholder)       return true;
      const inRange =
        s.date >= display.startDate &&
        s.date <= display.endDate   &&
        s.startTime === display.startTime &&
        s.endTime   === display.endTime;
      return !inRange;
    });
    // 会期が 0 件になっても会場カードは残す
    const groupActive = removed.filter((s) => s.groupId === groupId && !s.isPlaceholder);
    if (groupActive.length === 0) {
      const orig = workSites.find((s) => s.groupId === groupId);
      const siteName   = orig?.siteName   ?? '';
      const clientName = orig?.clientName ?? '';
      onChange([
        ...removed.filter((s) => s.groupId !== groupId),
        {
          id: createId(), groupId,
          groupLabel: `${formatSiteLabel(siteName, clientName)}：会期なし`,
          date: '', clientName, siteName,
          startTime: '', endTime: '',
          requiredPeople: 0, memo: '',
          isPlaceholder: true,
        },
      ]);
    } else {
      onChange(removed);
    }
  }

  // ── 会期アコーディオン ──────────────────────────────────────

  function toggleSession(key: string) {
    setExpandedSessions((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }

  function toggleVenue(groupId: string) {
    setExpandedVenues((prev) => {
      const next = new Set(prev);
      next.has(groupId) ? next.delete(groupId) : next.add(groupId);
      return next;
    });
  }

  function toggleDailyDetail(key: string) {
    setDetailedDailyKeys((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }

  function toggleSessionForm(id: string) {
    setExpandedSessionForms((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  // ── 会期エディタ操作 ────────────────────────────────────────

  function openGroupSessionEditor(groupId: string, sites: WorkSite[]) {
    setSessionEditor({
      groupId,
      clientName:  sites[0]?.clientName  ?? '',
      siteName:    sites[0]?.siteName    ?? '',
      subSiteName: sites[0]?.subSiteName ?? '',
      sessions:    deriveSessionsFromSites(sites),
      isExistingGroup: true,
      sourceIds:   [],
      newSessionIds: [],
    });
    setExpandedSessionForms(new Set());
    setSiteInfoExpanded(false);
  }

  function openGroupSessionEditorWithNewSession(groupId: string, sites: WorkSite[]) {
    const newSess = emptySession();
    setSessionEditor({
      groupId,
      clientName:  sites[0]?.clientName  ?? '',
      siteName:    sites[0]?.siteName    ?? '',
      subSiteName: sites[0]?.subSiteName ?? '',
      sessions:    [newSess, ...deriveSessionsFromSites(sites)],
      isExistingGroup: true,
      sourceIds:   [],
      newSessionIds: [newSess.id],
    });
    setExpandedSessionForms(new Set([newSess.id]));
    setSiteInfoExpanded(false);
  }

  function openSiteSessionEditor(site: WorkSite) {
    const sess: SessionForm = {
      id:             createId(),
      startDate:      site.date,
      endDate:        site.date,
      startTime:      site.startTime,
      endTime:        site.endTime,
      requiredPeople: site.requiredPeople,
      memo:           site.memo,
    };
    setSessionEditor({
      groupId:     createId(),
      clientName:  site.clientName  ?? '',
      siteName:    site.siteName,
      subSiteName: site.subSiteName ?? '',
      sessions:    [sess],
      isExistingGroup: false,
      sourceIds:   [site.id],
      newSessionIds: [],
    });
    setExpandedSessionForms(new Set([sess.id]));
    setSiteInfoExpanded(false);
  }

  function applySessionEditor() {
    if (!sessionEditor) return;
    const editMeta = sessionEditor.isExistingGroup
      ? { isManuallyEdited: true as const, manualEditedAt: new Date().toISOString() }
      : undefined;
    // displaySiteName / normalizedSiteKey / siteIdentityKey を確定させる
    const newSites  = normalizeImportedWorkSites(buildSessionSites(sessionEditor, editMeta));
    const remaining = sessionEditor.isExistingGroup
      ? workSites.filter((s) => s.groupId !== sessionEditor.groupId)
      : workSites.filter((s) => !sessionEditor.sourceIds.includes(s.id));
    onChange([...remaining, newSites].flat());
    setSessionEditor(null);
  }

  function updateSession(id: string, patch: Partial<SessionForm>) {
    setSessionEditor((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        sessions: prev.sessions.map((s) => s.id === id ? { ...s, ...patch } : s),
      };
    });
  }

  function addSession() {
    const newSess = emptySession();
    setSessionEditor((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        // 先頭に追加することで、スクロール不要でフォームが表示される
        sessions:     [newSess, ...prev.sessions],
        newSessionIds: [...prev.newSessionIds, newSess.id],
      };
    });
    setExpandedSessionForms((prev) => new Set([...prev, newSess.id]));
  }

  function removeSession(id: string) {
    setSessionEditor((prev) => {
      if (!prev) return prev;
      const remaining = prev.sessions.filter((s) => s.id !== id);
      const newIds    = prev.newSessionIds.filter((nid) => nid !== id);
      if (remaining.length > 0) {
        return { ...prev, sessions: remaining, newSessionIds: newIds };
      }
      // 全削除時: 空の新規フォームを先頭に置く
      const fallback = emptySession();
      return {
        ...prev,
        sessions:     [fallback],
        newSessionIds: [fallback.id],
      };
    });
  }

  function sessionPreviewCount(): number {
    if (!sessionEditor) return 0;
    return sessionEditor.sessions.reduce((sum, s) => sum + calcDayCount(s.startDate, s.endDate), 0);
  }

  // ── CSV 取込モーダル ────────────────────────────────────────

  function handleModalFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = (ev.target?.result ?? '') as string;
      setCsvModalPreview({ ...parseSiteCSV(text), fileName: file.name });
    };
    reader.readAsText(file, 'UTF-8');
  }

  function handleModalImport() {
    if (!csvModalPreview?.valid.length) return;

    // 重複チェック: overwrite モードでは CSV 由来は置換対象なので除外して判定する
    // buildCsvImportGroups が内部で normalize するため、検査専用に正規化する
    const normalizedForCheck = normalizeImportedWorkSites(csvModalPreview.valid);
    const effectiveExisting = csvModalOverwrite
      ? workSites.filter((s) => s.source !== 'csv')
      : workSites;
    const { duplicateCount, hasManualDuplicate } = countDuplicateVenues(
      normalizedForCheck,
      effectiveExisting,
    );
    if (duplicateCount > 0) {
      const manualWarning = hasManualDuplicate
        ? '\n⚠️ 手動登録済みの会場が含まれています。上書きされる可能性があります。'
        : '';
      const ok = window.confirm(
        `既存の会場と重複する会場が ${duplicateCount} 件あります。${manualWarning}\n\n取り込みを続けますか？`,
      );
      if (!ok) return;
    }

    const groups = buildCsvImportGroups(csvModalPreview.valid, csvModalPreview.fileName);
    const base = csvModalOverwrite
      ? workSites.filter((s) => s.source !== 'csv')
      : workSites;
    onChange([...base, ...groups]);

    // ImportLog を発行（バッチID・取込日時は buildCsvImportGroups が各サイトに付与済み）
    const batchId    = groups[0]?.importBatchId ?? createId();
    const importedAt = groups[0]?.importedAt    ?? new Date().toISOString();
    onAddImportLog({
      id:                createId(),
      importBatchId:     batchId,
      source:            'csv',
      sourceFileName:    csvModalPreview.fileName,
      importedAt,
      rowCount:          csvModalPreview.valid.length,
      importedSiteCount: groups.length,
      addedCount:        groups.length,
    });

    closeCsvModal();
  }

  function closeCsvModal() {
    setCsvModalOpen(false);
    setCsvModalPreview(null);
    setCsvModalOverwrite(false);
    if (csvFileRef.current) csvFileRef.current.value = '';
  }

  // ── 会期フォーム共通 JSX（新規登録・編集で共用） ──────────────

  function renderSessionFields(
    session: SessionForm,
    idx: number,
    onUpdate: (id: string, patch: Partial<SessionForm>) => void,
    onRemove: (id: string) => void,
    collapsible = false,
    isNew = false,
  ) {
    const dateError  = session.startDate && session.endDate && session.endDate < session.startDate;
    const isExpanded = !collapsible || expandedSessionForms.has(session.id);

    const dayCount    = calcDayCount(session.startDate, session.endDate);
    const timeStr     = session.startTime && session.endTime
      ? ` ${session.startTime}〜${session.endTime}` : '';
    const peopleStr   = session.requiredPeople
      ? ` ${session.requiredPeople}人` : '';
    const dateRange   = session.startDate && session.endDate
      ? session.startDate === session.endDate
        ? session.startDate.replace(/-/g, '/')
        : `${session.startDate.slice(5).replace('-', '/')}〜${session.endDate.slice(5).replace('-', '/')}`
      : null;
    const summaryLabel = dateRange
      ? `${dateRange}（${dayCount}日）${timeStr}${peopleStr}`
      : session.startDate
      ? `${session.startDate.replace(/-/g, '/')} → 終了日未設定`
      : '期間未設定';

    const cardClass = [
      'session-edit-card',
      !isExpanded ? 'session-edit-card--collapsed' : '',
      isNew       ? 'session-edit-card--new'       : '',
    ].filter(Boolean).join(' ');

    return (
      <div key={session.id} className={cardClass}>
        <div className="session-edit-card__title">
          {isNew ? (
            <span className="session-edit-card__new-badge">＋ 追加中</span>
          ) : collapsible ? (
            <button
              type="button"
              className="session-edit-card__toggle"
              onClick={() => toggleSessionForm(session.id)}>
              <span className="session-edit-card__label">会期 {idx + 1}</span>
              {!isExpanded && <span className="session-edit-card__summary">{summaryLabel}</span>}
              <span className="session-edit-card__chevron">{isExpanded ? '▲' : '▼'}</span>
            </button>
          ) : (
            <span>会期 {idx + 1}</span>
          )}
          <button type="button" className="btn btn--sm btn--ghost-danger"
            onClick={() => {
              if (!confirm('この会期を削除します。よろしいですか？')) return;
              onRemove(session.id);
            }}>
            削除
          </button>
        </div>
        {isExpanded && (
          <>
            <div className="session-edit-card__fields">
              <div className="edit-panel__field edit-panel__field--date-range">
                期間
                <SessionDateRangePicker
                  startDate={session.startDate}
                  endDate={session.endDate}
                  currentMonth={selectedMonth}
                  onChange={(s, e) => onUpdate(session.id, { startDate: s, endDate: e })}
                />
              </div>
              <label className="edit-panel__field">
                開始時間
                <input type="time" className="form-input form-input--short"
                  value={session.startTime}
                  onChange={(e) => onUpdate(session.id, { startTime: e.target.value })} />
              </label>
              <label className="edit-panel__field">
                終了時間
                <input type="time" className="form-input form-input--short"
                  value={session.endTime}
                  onChange={(e) => onUpdate(session.id, { endTime: e.target.value })} />
              </label>
              <label className="edit-panel__field">
                必要人数
                <input type="number" min={1} className="form-input form-input--short"
                  value={session.requiredPeople}
                  onChange={(e) => {
                    const raw = e.target.value;
                    if (raw === '') {
                      onUpdate(session.id, { requiredPeople: '' });
                    } else {
                      const num = parseInt(raw, 10);
                      onUpdate(session.id, { requiredPeople: isNaN(num) ? '' : num });
                    }
                  }} />
              </label>
              <label className="edit-panel__field edit-panel__field--memo">
                メモ
                <input type="text" className="form-input"
                  value={session.memo}
                  onChange={(e) => onUpdate(session.id, { memo: e.target.value })} />
              </label>
            </div>
            {dateError && (
              <p className="field-error">終了日は開始日以降を指定してください</p>
            )}
          </>
        )}
      </div>
    );
  }

  // ── 会期エディタ共通 JSX ────────────────────────────────────

  const sessionEditorContent = sessionEditor ? (
    <>
      {/* ── 基本情報（折りたたみ可能） ── */}
      <div className="session-editor__siteinfo">
        <button
          type="button"
          className="session-editor__siteinfo-toggle"
          onClick={() => setSiteInfoExpanded((v) => !v)}>
          <span>基本情報を編集</span>
          <span className="session-editor__siteinfo-chevron">
            {siteInfoExpanded ? '▲' : '▼'}
          </span>
        </button>
        {siteInfoExpanded && (
          <div className="session-editor__siteinfo-body">
            <label className="edit-panel__field edit-panel__field--wide">
              クライアント名
              <input type="text" className="form-input"
                value={sessionEditor.clientName}
                onChange={(e) => {
                  const v = e.target.value;
                  setSessionEditor((prev) => prev ? { ...prev, clientName: v } : prev);
                }} />
            </label>
            <label className="edit-panel__field edit-panel__field--wide">
              現場名
              <input type="text" className="form-input"
                value={sessionEditor.siteName}
                onChange={(e) => {
                  const v = e.target.value;
                  setSessionEditor((prev) => prev ? { ...prev, siteName: v } : prev);
                }} />
            </label>
            <label className="edit-panel__field edit-panel__field--wide">
              サブ会場名（区画・売場）
              <input type="text" className="form-input"
                value={sessionEditor.subSiteName}
                onChange={(e) => {
                  const v = e.target.value;
                  setSessionEditor((prev) => prev ? { ...prev, subSiteName: v } : prev);
                }}
                placeholder="2階ドラッグ側、センターコート 等（省略可）" />
            </label>
          </div>
        )}
      </div>

      {(() => {
        const newSessIds = new Set(sessionEditor.newSessionIds);
        const newForms  = sessionEditor.sessions.filter((s) => newSessIds.has(s.id));
        const existing  = sessionEditor.sessions.filter((s) => !newSessIds.has(s.id));
        return (
          <>
            {/* 新規追加会期: 上部・常時展開・追加中バッジ */}
            {newForms.map((session) =>
              renderSessionFields(session, 0, updateSession, removeSession, false, true)
            )}
            {/* 既存会期: 下部・折りたたみ */}
            {existing.map((session, idx) =>
              renderSessionFields(session, idx, updateSession, removeSession, true, false)
            )}
          </>
        );
      })()}

      <div className="session-editor__footer">
        <button type="button" className="btn btn--secondary" onClick={addSession}>
          ＋ 会期を追加
        </button>
        <div className="session-editor__footer-right">
          <span className="session-preview">{sessionPreviewCount()}件の現場日程を生成</span>
          <button type="button" className="btn btn--primary" onClick={applySessionEditor}>
            更新
          </button>
          <button type="button" className="btn btn--secondary" onClick={() => setSessionEditor(null)}>
            キャンセル
          </button>
        </div>
      </div>
    </>
  ) : null;

  return (
    <div>
      <h2>現場・必要人数管理</h2>

      {/* ── 新規現場登録フォーム ───────────────────────── */}
      <div className="card">
        <div className="site-list-header">
          <h3>現場を登録</h3>
          <button type="button" className="btn btn--secondary btn--sm" onClick={() => setCsvModalOpen(true)}>
            CSVから一括登録
          </button>
        </div>
        <p className="section-desc">
          現場名と会期（期間・時間・人数）を入力してください。会期は複数追加できます。
        </p>

        <form onSubmit={handleNewSiteSubmit} className="form">
          <div className="form-row">
            <label className="form-label">クライアント名</label>
            <input className="form-input" type="text" value={newClientName}
              onChange={(e) => setNewClientName(e.target.value)}
              placeholder="△△株式会社" />
          </div>

          <div className="form-row">
            <label className="form-label">現場名 *</label>
            <input className="form-input" type="text" value={newSiteName}
              onChange={(e) => setNewSiteName(e.target.value)}
              placeholder="〇〇倉庫" required />
          </div>

          <div className="form-row">
            <label className="form-label">サブ会場名</label>
            <input className="form-input" type="text" value={newSubSiteName}
              onChange={(e) => setNewSubSiteName(e.target.value)}
              placeholder="2階ドラッグ側、センターコート 等（省略可）" />
          </div>

          {newSessions.map((session, idx) =>
            renderSessionFields(session, idx, updateNewSession, removeNewSession)
          )}

          <div className="new-session-add">
            <button type="button" className="btn btn--secondary" onClick={addNewSession}>
              ＋ 会期を追加
            </button>
          </div>

          <div className={`preview-count${previewCount > 0 && !hasDateError ? ' preview-count--ready' : ''}`}>
            {hasDateError ? (
              <span className="preview-count__error">終了日は開始日以降を指定してください</span>
            ) : previewCount > 0 ? (
              <>
                <span className="preview-count__num">{previewCount}</span>
                <span className="preview-count__text">件の現場日程が作成されます</span>
              </>
            ) : (
              <span className="preview-count__empty">会期の期間を入力すると作成件数が表示されます</span>
            )}
          </div>

          <div className="form-actions">
            <button type="submit" className="btn btn--primary btn--large" disabled={!isReady}>
              登録
            </button>
          </div>
        </form>

        {successMsg && <div className="success-msg">{successMsg}</div>}
      </div>

      {/* ── 登録済み現場一覧 ─────────────────────────── */}
      <div className="card">
        <div className="site-list-header">
          <h3>登録済み現場 ({sortedGroups.length + ungroupedSites.length}件)</h3>
          <button className="btn btn--secondary btn--sm" onClick={() => setCsvModalOpen(true)}>
            CSV取込
          </button>
        </div>

        {sortedGroups.length === 0 && ungroupedSites.length === 0 ? (
          <div className="empty-state">
            <p className="empty-state__title">現場がまだ登録されていません</p>
            <p className="empty-state__desc">手動で登録するか、CSVから一括登録できます</p>
            <div className="empty-state__actions">
              <button className="btn btn--primary" onClick={() => setCsvModalOpen(true)}>
                CSVから一括登録
              </button>
            </div>
          </div>
        ) : (
          <div className="site-list">
            <div className="site-search">
              <input
                type="search"
                className="site-search__input"
                placeholder="現場名・クライアント名で検索"
                value={siteSearch}
                onChange={(e) => setSiteSearch(e.target.value)}
              />
              {siteSearch && (
                <span className="site-search__count">
                  {filteredGroups.length + filteredUngrouped.length} / {sortedGroups.length + ungroupedSites.length}件
                </span>
              )}
            </div>

            {filteredGroups.map(({ groupId, sites }) => {
              const isEditingSession    = sessionEditor?.groupId === groupId && sessionEditor.isExistingGroup;
              const activeSites          = sites.filter((s) => !s.isPlaceholder);
              const monthActiveSites     = activeSites.filter((s) => s.date.startsWith(selectedMonth));
              const monthDisplaySessions = groupSitesIntoDisplaySessions(monthActiveSites);
              const siteName            = sites[0]?.displaySiteName ?? sites[0]?.siteName ?? '';
              const clientName          = sites[0]?.clientName ?? '';
              const isVenueOpen         = expandedVenues.has(groupId);

              const venueStats = monthActiveSites.length > 0
                ? (() => {
                    const allPeople = monthDisplaySessions.flatMap((s) =>
                      s.dailyPeople.length > 0
                        ? s.dailyPeople.map((d) => d.requiredPeople)
                        : Array.from({ length: s.dateCount }, () => s.requiredPeople)
                    );
                    if (allPeople.length === 0) return null;
                    const maxPeople = Math.max(...allPeople);
                    const avgPeople = Math.round(allPeople.reduce((sum, p) => sum + p, 0) / allPeople.length);
                    return { maxPeople, avgPeople };
                  })()
                : null;

              return (
                <div key={groupId} className="site-card">
                  <div className="site-header">
                    <button className="site-header__main" onClick={() => toggleVenue(groupId)}>
                      <div className="site-header__info">
                        <div className="site-title">{formatSiteLabel(siteName, clientName)}</div>
                        <div className="site-meta">
                          {activeSites.length === 0 ? (
                            <span className="site-summary__unregistered">未登録</span>
                          ) : monthActiveSites.length === 0 ? (
                            <span className="site-summary__no-month">この月の会期なし</span>
                          ) : venueStats ? (
                            <>
                              <span className={`site-summary__peak site-summary__peak--${peakColorClass(venueStats.maxPeople, venueStats.avgPeople)}`}>
                                👥ピーク{venueStats.maxPeople}人
                              </span>
                              <span className="site-summary__avg">📊平均{venueStats.avgPeople}人</span>
                            </>
                          ) : null}
                        </div>
                      </div>
                      <span className="venue-chevron">{isVenueOpen ? '▲' : '▼'}</span>
                    </button>
                    <div className="site-actions">
                      {!isEditingSession && (
                        <button className="btn btn--sm btn--secondary"
                          onClick={() => openGroupSessionEditorWithNewSession(groupId, sites)}>
                          ＋会期を追加
                        </button>
                      )}
                      <button className="btn btn--sm btn--secondary"
                        onClick={() => isEditingSession
                          ? setSessionEditor(null)
                          : openGroupSessionEditor(groupId, sites)}>
                        {isEditingSession ? 'キャンセル' : '会期編集'}
                      </button>
                      <button className="btn btn--sm btn--ghost-danger"
                        onClick={() => deleteGroup(groupId)}>
                        削除
                      </button>
                    </div>
                  </div>

                  {isEditingSession && (
                    <div className="session-editor">
                      {sessionEditorContent}
                    </div>
                  )}

                  {isVenueOpen && (
                    <>
                      {activeSites.length === 0 ? (
                        <div className="site-empty">会期なし（まだ登録されていません）</div>
                      ) : monthActiveSites.length === 0 ? (
                        <div className="site-empty">この月の会期はありません</div>
                      ) : (
                        <div className="session-list">
                          {monthDisplaySessions.map((session) => {
                            const key    = `${groupId}-${session.sessionId}`;
                            const isOpen = expandedSessions.has(key);
                            const dailyRows = session.dailyPeople.length > 0
                              ? session.dailyPeople
                              : calcDateRange(session.startDate, session.endDate).map((date) => ({
                                  date, requiredPeople: session.requiredPeople,
                                }));
                            const sessionVals = session.dailyPeople.length > 0
                              ? session.dailyPeople.map((d) => d.requiredPeople)
                              : Array.from({ length: session.dateCount || 1 }, () => session.requiredPeople);
                            const sessionPeak = Math.max(...sessionVals);
                            const sessionAvg  = Math.round(sessionVals.reduce((sum, p) => sum + p, 0) / sessionVals.length);
                            return (
                              <div key={key} className="session-card">
                                <div className="session-card__header">
                                  <button
                                    className="session-summary"
                                    onClick={() => toggleSession(key)}>
                                    <span className="session-summary__date">
                                      📅 {session.startDate.replace(/-/g, '/')}〜{session.endDate.replace(/-/g, '/')}（{session.dateCount}日）
                                      <span className="session-chevron">{isOpen ? '▲' : '▼'}</span>
                                    </span>
                                    <div className="session-summary__meta">
                                      <span className="session-summary__time">⏰ {session.startTime}〜{session.endTime}</span>
                                      <span className={`session-summary__people session-summary__people--${peakColorClass(sessionPeak, sessionAvg)}`}>
                                        👥ピーク{sessionPeak}人　📊平均{sessionAvg}人
                                      </span>
                                    </div>
                                  </button>
                                  <button
                                    type="button"
                                    className="btn btn--sm btn--ghost-danger session-card__delete"
                                    onClick={() => {
                                      if (!confirm('この会期を削除します。よろしいですか？')) return;
                                      deleteDisplaySession(groupId, session);
                                    }}>
                                    削除
                                  </button>
                                </div>
                                {isOpen && (() => {
                                  const isDetailed = detailedDailyKeys.has(key);
                                  const fmt = isDetailed ? formatDateWithDow : formatDateShort;
                                  return (
                                    <div className="session-daily">
                                      <div className="session-daily__header">
                                        <button
                                          className="daily-toggle"
                                          onClick={() => toggleDailyDetail(key)}
                                        >
                                          {isDetailed ? '曜日を隠す' : '曜日を表示'}
                                        </button>
                                      </div>
                                      {groupDailyRows(dailyRows).map((group) => {
                                        const label = group.startDate === group.endDate
                                          ? fmt(group.startDate)
                                          : `${fmt(group.startDate)}〜${fmt(group.endDate)}`;
                                        return (
                                          <div key={group.startDate} className="daily-row">
                                            <span className="daily-row__date">{label}</span>
                                            <span className="daily-row__people">{group.requiredPeople}人</span>
                                          </div>
                                        );
                                      })}
                                      {session.memo && (
                                        <div className="daily-row daily-row--memo">
                                          <span className="daily-row__date">メモ</span>
                                          <span className="daily-row__people">{session.memo}</span>
                                        </div>
                                      )}
                                    </div>
                                  );
                                })()}
                              </div>
                            );
                          })}
                        </div>
                      )}

                      {!isEditingSession && (
                        <button
                          className="btn btn--sm btn--secondary site-add-session-btn"
                          onClick={() => openGroupSessionEditorWithNewSession(groupId, sites)}>
                          ＋ 会期を追加
                        </button>
                      )}
                    </>
                  )}
                </div>
              );
            })}

            {filteredUngrouped.length > 0 && (
              <div className="site-ungrouped-section">
                <p className="site-ungrouped-label">グループなし（{filteredUngrouped.length}件）</p>
                {filteredUngrouped.map((site) => {
                  const isConvertingThis =
                    !sessionEditor?.isExistingGroup &&
                    (sessionEditor?.sourceIds.includes(site.id) ?? false);
                  return (
                    <div key={site.id} className="site-card site-card--ungrouped">
                      <div className="site-header">
                        <div className="site-header__left">
                          <div className="site-title">{formatSiteLabel(site.displaySiteName ?? site.siteName, site.clientName)}</div>
                          <div className="site-meta">{site.date}</div>
                        </div>
                        <div className="site-actions">
                          <button className="btn btn--sm btn--secondary"
                            onClick={() => isConvertingThis
                              ? setSessionEditor(null)
                              : openSiteSessionEditor(site)}>
                            {isConvertingThis ? 'キャンセル' : '会期化'}
                          </button>
                          <button className="btn btn--sm btn--ghost-danger"
                            onClick={() => deleteSite(site.id)}>
                            削除
                          </button>
                        </div>
                      </div>
                      {isConvertingThis && (
                        <div className="session-editor session-editor--inline">
                          {sessionEditorContent}
                        </div>
                      )}
                      <div className="site-detail">
                        {site.startTime}〜{site.endTime} / {site.requiredPeople}人
                        {site.memo ? ` / ${site.memo}` : ''}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

          </div>
        )}
      </div>

      {/* ── CSV 取込モーダル ──────────────────────────── */}
      {csvModalOpen && (
        <div className="modal-overlay" onClick={closeCsvModal}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal__header">
              <h3>現場CSVを取り込む</h3>
              <button className="modal__close" onClick={closeCsvModal}>✕</button>
            </div>
            <div className="modal__body">
              <div className="import-upload">
                <input
                  type="file"
                  accept=".csv"
                  id="ws-modal-csv"
                  ref={csvFileRef}
                  className="file-input-hidden"
                  onChange={handleModalFileChange}
                />
                <label htmlFor="ws-modal-csv" className="btn btn--secondary">
                  CSVファイルを選択
                </label>
                {csvModalPreview && (
                  <span className="import-current">{csvModalPreview.fileName}</span>
                )}
              </div>

              <div className="import-overwrite">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={csvModalOverwrite}
                    onChange={(e) => setCsvModalOverwrite(e.target.checked)}
                  />
                  上書きモード（既存CSVデータを置換）
                </label>
                {csvModalOverwrite && (
                  <span className="import-overwrite__note">
                    既存のCSV取込済み現場をすべて削除してから登録します
                  </span>
                )}
              </div>

              {csvModalPreview && (
                <div className="import-preview">
                  {csvModalPreview.errors.length > 0 && (
                    <div className="import-errors">
                      <div className="import-errors__title">
                        エラー {csvModalPreview.errors.length}件（該当行はスキップ）
                      </div>
                      {csvModalPreview.errors.map((err, i) => (
                        <div key={i} className="import-error-row">
                          {err.row}行目：{err.message}
                        </div>
                      ))}
                    </div>
                  )}
                  {csvModalPreview.valid.length > 0 ? (
                    <div className="import-count">
                      <span className="import-count__num">{csvModalPreviewCounts.venueCount}</span>
                      現場・
                      <span className="import-count__num">{csvModalPreviewCounts.sessionCount}</span>
                      会期を取り込みます
                    </div>
                  ) : (
                    <p className="import-no-valid">有効なデータがありません</p>
                  )}
                </div>
              )}
            </div>
            <div className="modal__footer">
              <button
                className="btn btn--primary"
                disabled={!csvModalPreview?.valid.length}
                onClick={handleModalImport}
              >
                取り込む
              </button>
              <button className="btn btn--secondary" onClick={closeCsvModal}>
                キャンセル
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
