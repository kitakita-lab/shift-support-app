import { useState, useMemo } from 'react';
import { WorkSite } from '../types';

// ─── ヘルパー関数 ──────────────────────────────────────────

const createId = (): string =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `id-${Date.now()}-${Math.random().toString(36).slice(2)}`;

// YYYY-MM-DD を必ずローカル日付として解釈する。
// YYYY-MM-DD と YYYY/MM/DD の両方を受け付け、必ずローカル日付として構築する。
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
  siteName: string;
  sessions: SessionForm[];
  isExistingGroup: boolean;
  sourceIds: string[];
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

function computeGroupLabel(siteName: string, sessions: SessionForm[]): string {
  const valid = sessions.filter((s) => s.startDate && s.endDate);
  if (valid.length === 0) return `${siteName}：会期なし`;
  if (valid.length === 1) return `${siteName}：${valid[0].startDate}〜${valid[0].endDate}`;
  return `${siteName}：複数会期`;
}

function buildSessionSites(state: SessionEditorState): WorkSite[] {
  const { groupId, siteName, sessions } = state;
  const groupLabel = computeGroupLabel(siteName, sessions);
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
        siteName,
        startTime:      session.startTime,
        endTime:        session.endTime,
        requiredPeople: normalizeRequiredPeople(session.requiredPeople),
        memo:           session.memo,
      });
    }
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
  requiredPeople: number;
  memo: string;
  dateCount: number;
}

function groupSitesIntoDisplaySessions(sites: WorkSite[]): DisplaySession[] {
  const active = sites.filter((s) => !s.isPlaceholder);
  if (active.length === 0) return [];

  const raw: Omit<DisplaySession, 'sessionNo'>[] = [];
  const hasSessionIds = active.some((s) => s.sessionId);

  if (hasSessionIds) {
    const bySession = new Map<string, WorkSite[]>();
    for (const site of active) {
      const key = site.sessionId ?? `__nosession_${site.date}`;
      if (!bySession.has(key)) bySession.set(key, []);
      bySession.get(key)!.push(site);
    }
    for (const [key, group] of bySession) {
      const g = [...group].sort((a, b) => a.date.localeCompare(b.date));
      raw.push({
        sessionId:      g[0].sessionId ?? key,
        startDate:      g[0].date,
        endDate:        g[g.length - 1].date,
        startTime:      g[0].startTime,
        endTime:        g[0].endTime,
        requiredPeople: g[0].requiredPeople,
        memo:           g[0].memo,
        dateCount:      g.length,
      });
    }
  } else {
    // Fallback: gap detection for legacy records without sessionId
    const sorted = [...active].sort((a, b) => a.date.localeCompare(b.date));
    let current: WorkSite[] = [sorted[0]];
    const flushCurrent = () => {
      const g = current;
      // Synthetic stable key for legacy data: start|end|startTime|endTime
      const syntheticId = `${g[0].date}|${g[g.length - 1].date}|${g[0].startTime}|${g[0].endTime}`;
      raw.push({
        sessionId:      syntheticId,
        startDate:      g[0].date,
        endDate:        g[g.length - 1].date,
        startTime:      g[0].startTime,
        endTime:        g[0].endTime,
        requiredPeople: g[0].requiredPeople,
        memo:           g[0].memo,
        dateCount:      g.length,
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
  }

  return raw
    .sort((a, b) => a.startDate.localeCompare(b.startDate))
    .map((s, i) => ({ ...s, sessionNo: i + 1 }));
}

// ─── Props ─────────────────────────────────────────────────

interface Props {
  workSites: WorkSite[];
  onChange: (workSites: WorkSite[]) => void;
}

// ─── component ─────────────────────────────────────────────

export default function WorkSiteManager({ workSites, onChange }: Props) {
  // ── 新規現場登録フォーム
  const [newSiteName, setNewSiteName] = useState('');
  const [newSessions, setNewSessions] = useState<SessionForm[]>([emptySession()]);
  const [successMsg, setSuccessMsg]   = useState('');

  // ── 会期エディタ・アコーディオン
  const [sessionEditor,     setSessionEditor]     = useState<SessionEditorState | null>(null);
  const [expandedSessions,  setExpandedSessions]  = useState<Set<string>>(new Set());

  // ── 登録プレビュー計算
  const previewCount = useMemo(() =>
    newSessions.reduce((sum, s) => sum + calcDayCount(s.startDate, s.endDate), 0),
  [newSessions]);

  const hasDateError = useMemo(() =>
    newSessions.some((s) => s.startDate && s.endDate && s.endDate < s.startDate),
  [newSessions]);

  const isReady = newSiteName.trim() !== '' && previewCount > 0 && !hasDateError;

  // ── グループ化
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
      .sort((a, b) => (a.sites[0]?.date ?? '').localeCompare(b.sites[0]?.date ?? ''));
    return {
      sortedGroups: groupEntries,
      ungroupedSites: [...ungrouped].sort((a, b) => a.date.localeCompare(b.date)),
    };
  }, [workSites]);

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
    const groupId    = createId();
    const groupLabel = computeGroupLabel(newSiteName, newSessions);
    const newSites: WorkSite[] = [];
    for (const session of newSessions) {
      const sessionId = session.id;
      for (const date of calcDateRange(session.startDate, session.endDate)) {
        newSites.push({
          id: createId(),
          groupId,
          groupLabel,
          sessionId,
          date,
          siteName:       newSiteName,
          startTime:      session.startTime,
          endTime:        session.endTime,
          requiredPeople: normalizeRequiredPeople(session.requiredPeople),
          memo:           session.memo,
        });
      }
    }
    onChange([...workSites, ...newSites]);
    setSuccessMsg(`${newSites.length}件の現場を登録しました`);
    setNewSiteName('');
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
    // sessionId のみで削除対象を特定する。sessionId がない行は削除しない
    const removed = workSites.filter((s) => {
      if (s.groupId !== groupId) return true;
      if (!s.sessionId) return true;
      return s.sessionId !== display.sessionId;
    });
    onChange(removed);
  }

  // ── 会期アコーディオン ──────────────────────────────────────

  function toggleSession(key: string) {
    setExpandedSessions((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }

  // ── 会期エディタ操作 ────────────────────────────────────────

  function openGroupSessionEditor(groupId: string, sites: WorkSite[]) {
    setSessionEditor({
      groupId,
      siteName: sites[0]?.siteName ?? '',
      sessions: deriveSessionsFromSites(sites),
      isExistingGroup: true,
      sourceIds: [],
    });
  }

  function openGroupSessionEditorWithNewSession(groupId: string, sites: WorkSite[]) {
    setSessionEditor({
      groupId,
      siteName: sites[0]?.siteName ?? '',
      sessions: [...deriveSessionsFromSites(sites), emptySession()],
      isExistingGroup: true,
      sourceIds: [],
    });
  }

  function openSiteSessionEditor(site: WorkSite) {
    setSessionEditor({
      groupId:  createId(),
      siteName: site.siteName,
      sessions: [{
        id:             createId(),
        startDate:      site.date,
        endDate:        site.date,
        startTime:      site.startTime,
        endTime:        site.endTime,
        requiredPeople: site.requiredPeople,
        memo:           site.memo,
      }],
      isExistingGroup: false,
      sourceIds: [site.id],
    });
  }

  function applySessionEditor() {
    if (!sessionEditor) return;
    const newSites  = buildSessionSites(sessionEditor);
    const remaining = sessionEditor.isExistingGroup
      ? workSites.filter((s) => s.groupId !== sessionEditor.groupId)
      : workSites.filter((s) => !sessionEditor.sourceIds.includes(s.id));
    onChange([...remaining, ...newSites]);
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
    setSessionEditor((prev) => {
      if (!prev) return prev;
      return { ...prev, sessions: [...prev.sessions, emptySession()] };
    });
  }

  function removeSession(id: string) {
    setSessionEditor((prev) => {
      if (!prev) return prev;
      const remaining = prev.sessions.filter((s) => s.id !== id);
      return {
        ...prev,
        sessions: remaining.length > 0 ? remaining : [emptySession()],
      };
    });
  }

  function sessionPreviewCount(): number {
    if (!sessionEditor) return 0;
    return sessionEditor.sessions.reduce((sum, s) => sum + calcDayCount(s.startDate, s.endDate), 0);
  }

  // ── 会期フォーム共通 JSX（新規登録・編集で共用） ──────────────

  function renderSessionFields(
    session: SessionForm,
    idx: number,
    onUpdate: (id: string, patch: Partial<SessionForm>) => void,
    onRemove: (id: string) => void
  ) {
    const dateError = session.startDate && session.endDate && session.endDate < session.startDate;
    return (
      <div key={session.id} className="session-edit-card">
        <div className="session-edit-card__title">
          <span>会期 {idx + 1}</span>
          <button type="button" className="btn btn--sm btn--danger"
            onClick={() => {
              if (!confirm('この会期を削除します。よろしいですか？')) return;
              onRemove(session.id);
            }}>
            この会期を削除
          </button>
        </div>
        <div className="session-edit-card__fields">
          <label className="edit-panel__field">
            開始日
            <input type="date" className="form-input form-input--short"
              value={session.startDate}
              onChange={(e) => onUpdate(session.id, { startDate: e.target.value })} />
          </label>
          <label className="edit-panel__field">
            終了日
            <input type="date" className="form-input form-input--short"
              value={session.endDate}
              onChange={(e) => onUpdate(session.id, { endDate: e.target.value })} />
          </label>
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
      </div>
    );
  }

  // ── 会期エディタ共通 JSX ────────────────────────────────────

  const sessionEditorContent = sessionEditor ? (
    <>
      <div className="session-editor__sitename">
        <label className="edit-panel__field edit-panel__field--wide">
          現場名
          <input type="text" className="form-input"
            value={sessionEditor.siteName}
            onChange={(e) => {
              const v = e.target.value;
              setSessionEditor((prev) => prev ? { ...prev, siteName: v } : prev);
            }} />
        </label>
      </div>

      {sessionEditor.sessions.map((session, idx) =>
        renderSessionFields(session, idx, updateSession, removeSession)
      )}

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
        <h3>現場を登録</h3>
        <p className="section-desc">
          現場名と会期（期間・時間・人数）を入力してください。会期は複数追加できます。
        </p>

        <form onSubmit={handleNewSiteSubmit} className="form">
          <div className="form-row">
            <label className="form-label">現場名 *</label>
            <input className="form-input" type="text" value={newSiteName}
              onChange={(e) => setNewSiteName(e.target.value)}
              placeholder="〇〇倉庫" required />
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
        <h3>登録済み現場 ({sortedGroups.length + ungroupedSites.length}件)</h3>

        {sortedGroups.length === 0 && ungroupedSites.length === 0 ? (
          <p className="empty-msg">現場が登録されていません</p>
        ) : (
          <div className="site-list">

            {sortedGroups.map(({ groupId, sites }) => {
              const isEditingSession = sessionEditor?.groupId === groupId && sessionEditor.isExistingGroup;
              const displaySessions  = groupSitesIntoDisplaySessions(sites);
              const siteName         = sites[0]?.siteName ?? '';

              return (
                <div key={groupId} className="site-card">
                  <div className="site-header">
                    <div className="site-header__left">
                      <div className="site-title">{siteName}</div>
                      <div className="site-meta">
                        {`会期${displaySessions.length}件`}
                      </div>
                    </div>
                    <div className="site-actions">
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

                  <div className="session-list">
                      {displaySessions.map((session) => {
                        const key    = `${groupId}-${session.sessionId}`;
                        const isOpen = expandedSessions.has(key);
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
                                  <span className="session-summary__people">👤 {session.requiredPeople}人</span>
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
                            {isOpen && (
                              <div className="session-detail">
                                <div className="session-detail__row">
                                  <span className="session-detail__label">期間</span>
                                  <span>{session.startDate}〜{session.endDate}（{session.dateCount}日）</span>
                                </div>
                                <div className="session-detail__row">
                                  <span className="session-detail__label">時間</span>
                                  <span>{session.startTime}〜{session.endTime}</span>
                                </div>
                                <div className="session-detail__row">
                                  <span className="session-detail__label">必要人数</span>
                                  <span>{session.requiredPeople}人</span>
                                </div>
                                {session.memo && (
                                  <div className="session-detail__row">
                                    <span className="session-detail__label">メモ</span>
                                    <span>{session.memo}</span>
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>

                  {!isEditingSession && (
                    <button
                      className="btn btn--sm btn--secondary site-add-session-btn"
                      onClick={() => openGroupSessionEditorWithNewSession(groupId, sites)}>
                      ＋ 会期を追加
                    </button>
                  )}
                </div>
              );
            })}

            {ungroupedSites.length > 0 && (
              <div className="site-ungrouped-section">
                <p className="site-ungrouped-label">グループなし（{ungroupedSites.length}件）</p>
                {ungroupedSites.map((site) => {
                  const isConvertingThis =
                    !sessionEditor?.isExistingGroup &&
                    (sessionEditor?.sourceIds.includes(site.id) ?? false);
                  return (
                    <div key={site.id} className="site-card site-card--ungrouped">
                      <div className="site-header">
                        <div className="site-header__left">
                          <div className="site-title">{site.siteName}</div>
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
    </div>
  );
}
