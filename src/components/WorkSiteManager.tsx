import { useState, useMemo } from 'react';
import { WorkSite } from '../types';

// ─── ヘルパー関数 ──────────────────────────────────────────

function calcDateRange(startDate: string, endDate: string): string[] {
  if (!startDate || !endDate || endDate < startDate) return [];
  const dates: string[] = [];
  const cursor = new Date(startDate + 'T00:00:00');
  const end    = new Date(endDate   + 'T00:00:00');
  while (cursor <= end) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setDate(cursor.getDate() + 1);
  }
  return dates;
}

function calcDayCount(startDate: string, endDate: string): number {
  if (!startDate || !endDate || endDate < startDate) return 0;
  const start = new Date(startDate + 'T00:00:00');
  const end   = new Date(endDate   + 'T00:00:00');
  return Math.floor((end.getTime() - start.getTime()) / 86400000) + 1;
}

// ─── SessionForm (会期) ────────────────────────────────────

interface SessionForm {
  id: string;
  startDate: string;
  endDate: string;
  startTime: string;
  endTime: string;
  requiredPeople: number;
  memo: string;
}

interface SessionEditorState {
  groupId: string;
  siteName: string;
  sessions: SessionForm[];
  isExistingGroup: boolean;
  sourceIds: string[];
}

function emptySession(): SessionForm {
  return {
    id: crypto.randomUUID(),
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
      result.push({
        id:             crypto.randomUUID(),
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
      id:             crypto.randomUUID(),
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
      (new Date(site.date + 'T00:00:00').getTime() - new Date(prev.date + 'T00:00:00').getTime()) / 86400000
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
    const sessionId = crypto.randomUUID();
    for (const date of calcDateRange(session.startDate, session.endDate)) {
      sites.push({
        id: crypto.randomUUID(),
        groupId,
        groupLabel,
        sessionId,
        date,
        siteName,
        startTime:      session.startTime,
        endTime:        session.endTime,
        requiredPeople: session.requiredPeople,
        memo:           session.memo,
      });
    }
  }
  if (sites.length === 0) {
    return [{
      id: crypto.randomUUID(),
      groupId,
      groupLabel,
      date: '',
      siteName,
      startTime: '',
      endTime: '',
      requiredPeople: 0,
      memo: '',
      isPlaceholder: true,
    }];
  }
  return sites;
}

// ─── DisplaySession (会期表示用) ──────────────────────────────

interface DisplaySession {
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
    for (const [, group] of bySession) {
      const g = [...group].sort((a, b) => a.date.localeCompare(b.date));
      raw.push({
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
      raw.push({
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
        (new Date(site.date + 'T00:00:00').getTime() - new Date(prev.date + 'T00:00:00').getTime()) / 86400000
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
    const groupId    = crypto.randomUUID();
    const groupLabel = computeGroupLabel(newSiteName, newSessions);
    const newSites: WorkSite[] = [];
    for (const session of newSessions) {
      const sessionId = crypto.randomUUID();
      for (const date of calcDateRange(session.startDate, session.endDate)) {
        newSites.push({
          id: crypto.randomUUID(),
          groupId,
          groupLabel,
          sessionId,
          date,
          siteName:       newSiteName,
          startTime:      session.startTime,
          endTime:        session.endTime,
          requiredPeople: session.requiredPeople,
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
      groupId:  crypto.randomUUID(),
      siteName: site.siteName,
      sessions: [{
        id:             crypto.randomUUID(),
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
    if (!sessionEditor) return;
    setSessionEditor({
      ...sessionEditor,
      sessions: sessionEditor.sessions.map((s) => s.id === id ? { ...s, ...patch } : s),
    });
  }

  function addSession() {
    if (!sessionEditor) return;
    setSessionEditor({ ...sessionEditor, sessions: [...sessionEditor.sessions, emptySession()] });
  }

  function removeSession(id: string) {
    if (!sessionEditor) return;
    const remaining = sessionEditor.sessions.filter((s) => s.id !== id);
    setSessionEditor({
      ...sessionEditor,
      sessions: remaining.length > 0 ? remaining : [emptySession()],
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
            onClick={() => onRemove(session.id)}>
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
              onChange={(e) => onUpdate(session.id, { requiredPeople: Number(e.target.value) })} />
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
            onChange={(e) => setSessionEditor({ ...sessionEditor, siteName: e.target.value })} />
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
              const activeSites      = sites.filter((s) => !s.isPlaceholder);
              const displaySessions  = groupSitesIntoDisplaySessions(sites);
              const siteName         = sites[0]?.siteName ?? '';

              return (
                <div key={groupId} className="site-card">
                  <div className="site-header">
                    <div className="site-header__left">
                      <div className="site-title">{siteName}</div>
                      <div className="site-meta">
                        {activeSites.length === 0 ? '会期なし' : `会期${displaySessions.length}件`}
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

                  {activeSites.length === 0 ? (
                    <div className="site-empty">会期なし（まだ登録されていません）</div>
                  ) : (
                    <div className="session-list">
                      {displaySessions.map((session, idx) => {
                        const key    = `${groupId}-${idx}`;
                        const isOpen = expandedSessions.has(key);
                        return (
                          <div key={key} className="session-card">
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
                  )}

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
