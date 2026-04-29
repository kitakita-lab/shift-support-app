import { useState, useMemo } from 'react';
import { WorkSite } from '../types';

const WEEKDAYS = [
  { label: '月', day: 1 },
  { label: '火', day: 2 },
  { label: '水', day: 3 },
  { label: '木', day: 4 },
  { label: '金', day: 5 },
  { label: '土', day: 6 },
  { label: '日', day: 0 },
];

// ─── BulkForm (一括登録) ────────────────────────────────────

interface BulkForm {
  siteName: string;
  startDate: string;
  endDate: string;
  targetWeekdays: string[];
  startTime: string;
  endTime: string;
  requiredPeople: number;
  excludedDates: string[];
  memo: string;
}

function emptyBulkForm(): BulkForm {
  return {
    siteName: '',
    startDate: '',
    endDate: '',
    targetWeekdays: ['月', '火', '水', '木', '金'],
    startTime: '09:00',
    endTime: '18:00',
    requiredPeople: 1,
    excludedDates: [],
    memo: '',
  };
}

function calcTargetDates(
  startDate: string,
  endDate: string,
  targetWeekdays: string[],
  excludedDates: string[]
): string[] {
  if (!startDate || !endDate || startDate > endDate) return [];
  const weekdayNums = new Set(
    WEEKDAYS.filter((w) => targetWeekdays.includes(w.label)).map((w) => w.day)
  );
  const excludedSet = new Set(excludedDates);
  const dates: string[] = [];
  const cursor = new Date(startDate + 'T00:00:00');
  const end = new Date(endDate + 'T00:00:00');
  while (cursor <= end) {
    if (weekdayNums.has(cursor.getDay())) {
      const iso = cursor.toISOString().slice(0, 10);
      if (!excludedSet.has(iso)) dates.push(iso);
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return dates;
}

// ─── SessionForm (会期編集) ─────────────────────────────────

interface SessionForm {
  id: string;
  startDate: string;
  endDate: string;
  targetWeekdays: string[];
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
    targetWeekdays: ['月', '火', '水', '木', '金'],
    startTime: '09:00',
    endTime: '18:00',
    requiredPeople: 1,
    memo: '',
  };
}

function deriveSessionsFromSites(sites: WorkSite[]): SessionForm[] {
  const activeSites = sites.filter((s) => !s.isPlaceholder);
  if (activeSites.length === 0) return [];
  const sorted = [...activeSites].sort((a, b) => a.date.localeCompare(b.date));
  const usedDays = new Set(sorted.map((s) => new Date(s.date + 'T00:00:00').getDay()));
  const targetWeekdays = WEEKDAYS.filter((w) => usedDays.has(w.day)).map((w) => w.label);
  const first = sorted[0];
  return [{
    id: crypto.randomUUID(),
    startDate: sorted[0].date,
    endDate: sorted[sorted.length - 1].date,
    targetWeekdays,
    startTime: first.startTime,
    endTime: first.endTime,
    requiredPeople: first.requiredPeople,
    memo: first.memo,
  }];
}

function computeGroupLabel(siteName: string, sessions: SessionForm[]): string {
  if (sessions.length === 0) return `${siteName}：会期なし`;
  if (sessions.length === 1) return `${siteName}：${sessions[0].startDate}〜${sessions[0].endDate}`;
  return `${siteName}：複数会期`;
}

function buildSessionSites(state: SessionEditorState): WorkSite[] {
  const { groupId, siteName, sessions } = state;
  const groupLabel = computeGroupLabel(siteName, sessions);
  if (sessions.length === 0) {
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
  const sites: WorkSite[] = [];
  for (const session of sessions) {
    const dates = calcTargetDates(session.startDate, session.endDate, session.targetWeekdays, []);
    for (const date of dates) {
      sites.push({
        id: crypto.randomUUID(),
        groupId,
        groupLabel,
        date,
        siteName,
        startTime: session.startTime,
        endTime: session.endTime,
        requiredPeople: session.requiredPeople,
        memo: session.memo,
      });
    }
  }
  return sites;
}

// ─── DisplaySession (会期表示用) ──────────────────────────────

interface DisplaySession {
  sessionNo: number;
  startDate: string;
  endDate: string;
  weekdays: string[];
  startTime: string;
  endTime: string;
  requiredPeople: number;
  memo: string;
  dateCount: number;
}

function groupSitesIntoDisplaySessions(sites: WorkSite[]): DisplaySession[] {
  const active = sites.filter((s) => !s.isPlaceholder);
  if (active.length === 0) return [];
  const sorted = [...active].sort((a, b) => a.date.localeCompare(b.date));
  const map = new Map<string, WorkSite[]>();
  for (const site of sorted) {
    const key = `${site.startTime}|${site.endTime}|${site.requiredPeople}|${site.memo}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(site);
  }
  const raw: Omit<DisplaySession, 'sessionNo'>[] = [];
  for (const [, group] of map) {
    const g = [...group].sort((a, b) => a.date.localeCompare(b.date));
    const usedDays = new Set(g.map((s) => new Date(s.date + 'T00:00:00').getDay()));
    raw.push({
      startDate: g[0].date,
      endDate: g[g.length - 1].date,
      weekdays: WEEKDAYS.filter((w) => usedDays.has(w.day)).map((w) => w.label),
      startTime: g[0].startTime,
      endTime: g[0].endTime,
      requiredPeople: g[0].requiredPeople,
      memo: g[0].memo,
      dateCount: g.length,
    });
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
  const [form, setForm]                   = useState<BulkForm>(emptyBulkForm());
  const [excludeInput, setExcludeInput]   = useState('');
  const [successMsg, setSuccessMsg]       = useState('');
  const [sessionEditor, setSessionEditor] = useState<SessionEditorState | null>(null);
  const [expandedSessions, setExpandedSessions] = useState<Set<string>>(new Set());

  const targetDates = useMemo(
    () => calcTargetDates(form.startDate, form.endDate, form.targetWeekdays, form.excludedDates),
    [form]
  );

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

  // ── 一括登録 ──────────────────────────────────────────────

  function toggleBulkWeekday(label: string) {
    setForm((p) => ({
      ...p,
      targetWeekdays: p.targetWeekdays.includes(label)
        ? p.targetWeekdays.filter((d) => d !== label)
        : [...p.targetWeekdays, label],
    }));
  }

  function addExclude() {
    if (!excludeInput || form.excludedDates.includes(excludeInput)) return;
    setForm((p) => ({ ...p, excludedDates: [...p.excludedDates, excludeInput].sort() }));
    setExcludeInput('');
  }

  function handleBulkSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.siteName.trim() || targetDates.length === 0) return;
    const groupId = crypto.randomUUID();
    const newSites: WorkSite[] = targetDates.map((date) => ({
      id: crypto.randomUUID(),
      groupId,
      date,
      siteName: form.siteName,
      startTime: form.startTime,
      endTime: form.endTime,
      requiredPeople: form.requiredPeople,
      memo: form.memo,
    }));
    onChange([...workSites, ...newSites]);
    setSuccessMsg(`${newSites.length}件の現場を登録しました`);
    setForm(emptyBulkForm());
    setExcludeInput('');
    setTimeout(() => setSuccessMsg(''), 4000);
  }

  // ── グループ操作 ───────────────────────────────────────────

  function deleteGroup(groupId: string) {
    const count = workSites.filter((s) => s.groupId === groupId).length;
    if (!confirm(`このグループ（${count}件）をすべて削除します。よろしいですか？`)) return;
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
    const dow = new Date(site.date + 'T00:00:00').getDay();
    const w   = WEEKDAYS.find((x) => x.day === dow);
    setSessionEditor({
      groupId: crypto.randomUUID(),
      siteName: site.siteName,
      sessions: [{
        id: crypto.randomUUID(),
        startDate: site.date,
        endDate:   site.date,
        targetWeekdays: w ? [w.label] : [],
        startTime: site.startTime,
        endTime:   site.endTime,
        requiredPeople: site.requiredPeople,
        memo: site.memo,
      }],
      isExistingGroup: false,
      sourceIds: [site.id],
    });
  }

  function applySessionEditor() {
    if (!sessionEditor) return;
    const newSites = buildSessionSites(sessionEditor);
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

  function toggleSessionWeekday(sessionId: string, label: string) {
    const session = sessionEditor?.sessions.find((s) => s.id === sessionId);
    if (!session) return;
    updateSession(sessionId, {
      targetWeekdays: session.targetWeekdays.includes(label)
        ? session.targetWeekdays.filter((d) => d !== label)
        : [...session.targetWeekdays, label],
    });
  }

  function addSession() {
    if (!sessionEditor) return;
    setSessionEditor({ ...sessionEditor, sessions: [...sessionEditor.sessions, emptySession()] });
  }

  function removeSession(id: string) {
    if (!sessionEditor) return;
    setSessionEditor({ ...sessionEditor, sessions: sessionEditor.sessions.filter((s) => s.id !== id) });
  }

  function sessionPreviewCount(): number {
    if (!sessionEditor) return 0;
    return sessionEditor.sessions.reduce((sum, s) =>
      sum + calcTargetDates(s.startDate, s.endDate, s.targetWeekdays, []).length, 0);
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

      {sessionEditor.sessions.length === 0 && (
        <p className="session-editor__empty">
          会期が0件の場合、現場データは残りますが日程は生成されません（シフト作成・出力対象外）。
        </p>
      )}

      {sessionEditor.sessions.map((session, idx) => (
        <div key={session.id} className="session-edit-card">
          <div className="session-edit-card__title">
            <span>会期 {idx + 1}</span>
            <button type="button" className="btn btn--sm btn--danger"
              onClick={() => removeSession(session.id)}>
              この会期を削除
            </button>
          </div>
          <div className="session-edit-card__fields">
            <label className="edit-panel__field">
              開始日
              <input type="date" className="form-input form-input--short"
                value={session.startDate}
                onChange={(e) => updateSession(session.id, { startDate: e.target.value })} />
            </label>
            <label className="edit-panel__field">
              終了日
              <input type="date" className="form-input form-input--short"
                value={session.endDate}
                onChange={(e) => updateSession(session.id, { endDate: e.target.value })} />
            </label>
            <label className="edit-panel__field">
              対象曜日
              <div className="weekday-group weekday-group--sm">
                {WEEKDAYS.map(({ label }) => (
                  <label key={label} className="weekday-label weekday-label--sm">
                    <input type="checkbox"
                      checked={session.targetWeekdays.includes(label)}
                      onChange={() => toggleSessionWeekday(session.id, label)} />
                    {label}
                  </label>
                ))}
              </div>
            </label>
            <label className="edit-panel__field">
              開始時間
              <input type="time" className="form-input form-input--short"
                value={session.startTime}
                onChange={(e) => updateSession(session.id, { startTime: e.target.value })} />
            </label>
            <label className="edit-panel__field">
              終了時間
              <input type="time" className="form-input form-input--short"
                value={session.endTime}
                onChange={(e) => updateSession(session.id, { endTime: e.target.value })} />
            </label>
            <label className="edit-panel__field">
              必要人数
              <input type="number" min={1} className="form-input form-input--short"
                value={session.requiredPeople}
                onChange={(e) => updateSession(session.id, { requiredPeople: Number(e.target.value) })} />
            </label>
            <label className="edit-panel__field edit-panel__field--memo">
              メモ
              <input type="text" className="form-input"
                value={session.memo}
                onChange={(e) => updateSession(session.id, { memo: e.target.value })} />
            </label>
          </div>
        </div>
      ))}

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

  const isReady = form.siteName.trim() !== '' && targetDates.length > 0;

  return (
    <div>
      <h2>現場・必要人数管理</h2>

      {/* ── 一括登録フォーム ─────────────────────────── */}
      <div className="card">
        <h3>現場を期間で一括登録</h3>
        <p className="section-desc">
          現場名・期間・曜日を指定するだけで、1ヶ月分の現場日程をまとめて作成できます。
          登録された現場はグループとして管理され、後からまとめて編集・削除できます。
        </p>

        <form onSubmit={handleBulkSubmit} className="form">
          <div className="form-row">
            <label className="form-label">現場名 *</label>
            <input className="form-input" type="text" value={form.siteName}
              onChange={(e) => setForm({ ...form, siteName: e.target.value })}
              placeholder="〇〇倉庫" required />
          </div>

          <div className="form-row">
            <label className="form-label">開始日 *</label>
            <input className="form-input form-input--short" type="date" value={form.startDate}
              onChange={(e) => setForm({ ...form, startDate: e.target.value })} required />
          </div>

          <div className="form-row">
            <label className="form-label">終了日 *</label>
            <input className="form-input form-input--short" type="date" value={form.endDate}
              onChange={(e) => setForm({ ...form, endDate: e.target.value })} required />
          </div>

          <div className="form-row">
            <label className="form-label">対象曜日 *</label>
            <div className="weekday-group">
              {WEEKDAYS.map(({ label }) => (
                <label key={label} className="weekday-label">
                  <input type="checkbox" checked={form.targetWeekdays.includes(label)}
                    onChange={() => toggleBulkWeekday(label)} />
                  {label}
                </label>
              ))}
            </div>
          </div>

          <div className="form-row">
            <label className="form-label">開始時間</label>
            <input className="form-input form-input--short" type="time" value={form.startTime}
              onChange={(e) => setForm({ ...form, startTime: e.target.value })} />
          </div>

          <div className="form-row">
            <label className="form-label">終了時間</label>
            <input className="form-input form-input--short" type="time" value={form.endTime}
              onChange={(e) => setForm({ ...form, endTime: e.target.value })} />
          </div>

          <div className="form-row">
            <label className="form-label">必要人数</label>
            <input className="form-input form-input--short" type="number" min={1}
              value={form.requiredPeople}
              onChange={(e) => setForm({ ...form, requiredPeople: Number(e.target.value) })} />
          </div>

          <div className="form-row">
            <label className="form-label">除外日</label>
            <div className="day-off-group">
              <div className="day-off-input-row">
                <input className="form-input" type="date" value={excludeInput}
                  onChange={(e) => setExcludeInput(e.target.value)} />
                <button type="button" className="btn btn--secondary" onClick={addExclude}>追加</button>
              </div>
              {form.excludedDates.length > 0 && (
                <div className="tag-list">
                  {form.excludedDates.map((d) => (
                    <span key={d} className="tag tag--exclude">
                      {d}
                      <button type="button" className="tag__remove"
                        onClick={() => setForm((p) => ({ ...p, excludedDates: p.excludedDates.filter((x) => x !== d) }))}>
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="form-row">
            <label className="form-label">メモ</label>
            <input className="form-input" type="text" value={form.memo}
              onChange={(e) => setForm({ ...form, memo: e.target.value })} placeholder="任意" />
          </div>

          <div className={`preview-count${targetDates.length > 0 ? ' preview-count--ready' : ''}`}>
            {form.startDate && form.endDate && form.startDate > form.endDate ? (
              <span className="preview-count__error">終了日は開始日以降を指定してください</span>
            ) : targetDates.length > 0 ? (
              <>
                <span className="preview-count__num">{targetDates.length}</span>
                <span className="preview-count__text">件の現場日程が作成されます</span>
              </>
            ) : (
              <span className="preview-count__empty">期間・曜日を選択すると作成件数が表示されます</span>
            )}
          </div>

          <div className="form-actions">
            <button type="submit" className="btn btn--primary btn--large" disabled={!isReady}>
              一括登録
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
                              <span className="session-no">会期{session.sessionNo}</span>
                              <span className="session-range">
                                {session.startDate.replace(/-/g, '/')}〜{session.endDate.replace(/-/g, '/')}｜{session.weekdays.join('')}｜{session.startTime}〜{session.endTime}｜{session.requiredPeople}人
                              </span>
                              <span className="session-chevron">{isOpen ? '▲' : '▼'}</span>
                            </button>
                            {isOpen && (
                              <div className="session-detail">
                                <div className="session-detail__row">
                                  <span className="session-detail__label">曜日</span>
                                  <span>{session.weekdays.join('・')}</span>
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
