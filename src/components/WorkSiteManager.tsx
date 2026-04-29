import { Fragment, useState, useMemo } from 'react';
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

// ─── helpers ───────────────────────────────────────────────

function deriveWeekdays(sites: WorkSite[]): string {
  const nums = new Set(sites.map((s) => new Date(s.date + 'T00:00:00').getDay()));
  return WEEKDAYS.filter((w) => nums.has(w.day)).map((w) => w.label).join('');
}

function deriveMonthLabel(sites: WorkSite[]): string {
  const sorted = [...sites].sort((a, b) => a.date.localeCompare(b.date));
  const first = new Date(sorted[0].date + 'T00:00:00');
  const last  = new Date(sorted[sorted.length - 1].date + 'T00:00:00');
  const fy = first.getFullYear(), ly = last.getFullYear();
  const fm = first.getMonth() + 1, lm = last.getMonth() + 1;
  const showYear = fy !== new Date().getFullYear() || ly !== new Date().getFullYear();
  if (fy === ly) {
    const prefix = showYear ? `${fy}年` : '';
    return fm === lm ? `${prefix}${fm}月分` : `${prefix}${fm}〜${lm}月分`;
  }
  return `${fy}年${fm}月〜${ly}年${lm}月分`;
}

function getGroupLabel(sites: WorkSite[]): string {
  if (sites.length === 0) return '(空)';
  if (sites[0].groupLabel) return sites[0].groupLabel;
  const sorted = [...sites].sort((a, b) => a.date.localeCompare(b.date));
  return `${deriveMonthLabel(sorted)}：${sorted[0].siteName}（${deriveWeekdays(sorted)}）`;
}

// ─── types ─────────────────────────────────────────────────

interface SiteEditForm {
  siteName: string;
  date: string;
  startTime: string;
  endTime: string;
  requiredPeople: number;
  memo: string;
}

interface Props {
  workSites: WorkSite[];
  onChange: (workSites: WorkSite[]) => void;
}

// ─── component ─────────────────────────────────────────────

export default function WorkSiteManager({ workSites, onChange }: Props) {
  // 一括登録フォーム
  const [form, setForm]               = useState<BulkForm>(emptyBulkForm());
  const [excludeInput, setExcludeInput] = useState('');
  const [successMsg, setSuccessMsg]   = useState('');

  // 個別行編集
  const [editingSiteId,  setEditingSiteId]  = useState<string | null>(null);
  const [siteEditForm,   setSiteEditForm]   = useState<SiteEditForm>({
    siteName: '', date: '', startTime: '', endTime: '', requiredPeople: 1, memo: '',
  });

  // 会期エディタ
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [sessionEditor,  setSessionEditor]  = useState<SessionEditorState | null>(null);

  const targetDates = useMemo(
    () => calcTargetDates(form.startDate, form.endDate, form.targetWeekdays, form.excludedDates),
    [form]
  );

  // グループ化
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

  function toggleGroup(groupId: string) {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      next.has(groupId) ? next.delete(groupId) : next.add(groupId);
      return next;
    });
  }

  function deleteGroup(groupId: string) {
    const count = workSites.filter((s) => s.groupId === groupId).length;
    if (!confirm(`このグループ（${count}件）をすべて削除します。よろしいですか？`)) return;
    onChange(workSites.filter((s) => s.groupId !== groupId));
    setExpandedGroups((p) => { const n = new Set(p); n.delete(groupId); return n; });
    if (sessionEditor?.groupId === groupId) setSessionEditor(null);
  }

  // ── 個別行編集 ─────────────────────────────────────────────

  function startSiteEdit(site: WorkSite) {
    setEditingSiteId(site.id);
    setSiteEditForm({
      siteName: site.siteName, date: site.date,
      startTime: site.startTime, endTime: site.endTime,
      requiredPeople: site.requiredPeople, memo: site.memo,
    });
    setSessionEditor(null);
  }

  function applySiteEdit(id: string) {
    onChange(workSites.map((s) => s.id === id ? { ...s, ...siteEditForm } : s));
    setEditingSiteId(null);
  }

  function deleteSite(id: string) {
    onChange(workSites.filter((s) => s.id !== id));
    if (editingSiteId === id) setEditingSiteId(null);
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
    setEditingSiteId(null);
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
    setEditingSiteId(null);
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
        <div key={session.id} className="session-card">
          <div className="session-card__title">
            <span>会期 {idx + 1}</span>
            <button type="button" className="btn btn--sm btn--danger"
              onClick={() => removeSession(session.id)}>
              この会期を削除
            </button>
          </div>
          <div className="session-card__fields">
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
        <h3>登録済み現場 ({workSites.length}件)</h3>

        {workSites.length === 0 ? (
          <p className="empty-msg">現場が登録されていません</p>
        ) : (
          <div className="site-list">

            {/* グループ */}
            {sortedGroups.map(({ groupId, sites }) => {
              const expanded         = expandedGroups.has(groupId);
              const isEditingSession = sessionEditor?.groupId === groupId && sessionEditor.isExistingGroup;
              const activeSites      = sites.filter((s) => !s.isPlaceholder);
              return (
                <div key={groupId} className="site-group">

                  {/* グループヘッダー */}
                  <div className="site-group__header">
                    <button className="site-group__toggle" onClick={() => toggleGroup(groupId)}
                      aria-label={expanded ? '閉じる' : '展開する'}>
                      {expanded ? '▼' : '▶'}
                    </button>
                    <span className="site-group__label">{getGroupLabel(sites)}</span>
                    <span className="site-group__count">{activeSites.length}件</span>
                    <div className="site-group__actions">
                      <button className="btn btn--sm btn--secondary"
                        onClick={() => isEditingSession
                          ? setSessionEditor(null)
                          : openGroupSessionEditor(groupId, sites)}>
                        {isEditingSession ? 'キャンセル' : '会期編集'}
                      </button>
                      <button className="btn btn--sm btn--danger" onClick={() => deleteGroup(groupId)}>
                        グループ削除
                      </button>
                    </div>
                  </div>

                  {/* 会期編集パネル */}
                  {isEditingSession && (
                    <div className="session-editor">
                      {sessionEditorContent}
                    </div>
                  )}

                  {/* アコーディオン：日別一覧 */}
                  {expanded && (
                    <div className="site-group__body">
                      {activeSites.length === 0 ? (
                        <p className="site-group__empty">
                          会期なし — 「会期編集」から日程を追加できます
                        </p>
                      ) : (
                      <div className="table-wrapper">
                        <table className="data-table">
                          <thead>
                            <tr>
                              <th>日付</th>
                              <th>開始</th>
                              <th>終了</th>
                              <th>必要人数</th>
                              <th>メモ</th>
                              <th></th>
                            </tr>
                          </thead>
                          <tbody>
                            {activeSites.map((site) => (
                              <Fragment key={site.id}>
                                <tr className={editingSiteId === site.id ? 'site-editing-row' : ''}>
                                  <td>{site.date}</td>
                                  <td>{site.startTime}</td>
                                  <td>{site.endTime}</td>
                                  <td>{site.requiredPeople}人</td>
                                  <td>{site.memo || '—'}</td>
                                  <td className="action-cell">
                                    <button className="btn btn--sm btn--secondary"
                                      onClick={() => editingSiteId === site.id
                                        ? setEditingSiteId(null)
                                        : startSiteEdit(site)}>
                                      {editingSiteId === site.id ? 'キャンセル' : '編集'}
                                    </button>
                                    <button className="btn btn--sm btn--danger"
                                      onClick={() => deleteSite(site.id)}>
                                      削除
                                    </button>
                                  </td>
                                </tr>

                                {editingSiteId === site.id && (
                                  <tr className="site-edit-row">
                                    <td colSpan={6}>
                                      <div className="site-edit-form">
                                        <label className="edit-panel__field edit-panel__field--wide">
                                          現場名
                                          <input type="text" className="form-input"
                                            value={siteEditForm.siteName}
                                            onChange={(e) => setSiteEditForm({ ...siteEditForm, siteName: e.target.value })} />
                                        </label>
                                        <label className="edit-panel__field">
                                          日付
                                          <input type="date" className="form-input form-input--short"
                                            value={siteEditForm.date}
                                            onChange={(e) => setSiteEditForm({ ...siteEditForm, date: e.target.value })} />
                                        </label>
                                        <label className="edit-panel__field">
                                          開始
                                          <input type="time" className="form-input form-input--short"
                                            value={siteEditForm.startTime}
                                            onChange={(e) => setSiteEditForm({ ...siteEditForm, startTime: e.target.value })} />
                                        </label>
                                        <label className="edit-panel__field">
                                          終了
                                          <input type="time" className="form-input form-input--short"
                                            value={siteEditForm.endTime}
                                            onChange={(e) => setSiteEditForm({ ...siteEditForm, endTime: e.target.value })} />
                                        </label>
                                        <label className="edit-panel__field">
                                          人数
                                          <input type="number" min={1} className="form-input form-input--short"
                                            value={siteEditForm.requiredPeople}
                                            onChange={(e) => setSiteEditForm({ ...siteEditForm, requiredPeople: Number(e.target.value) })} />
                                        </label>
                                        <label className="edit-panel__field edit-panel__field--memo">
                                          メモ
                                          <input type="text" className="form-input"
                                            value={siteEditForm.memo}
                                            onChange={(e) => setSiteEditForm({ ...siteEditForm, memo: e.target.value })} />
                                        </label>
                                        <button className="btn btn--primary btn--sm"
                                          onClick={() => applySiteEdit(site.id)}>
                                          更新
                                        </button>
                                      </div>
                                    </td>
                                  </tr>
                                )}
                              </Fragment>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}

            {/* グループなし（旧データ等） */}
            {ungroupedSites.length > 0 && (
              <div className="site-group site-group--ungrouped">
                <div className="site-group__header">
                  <span className="site-group__label">グループなし</span>
                  <span className="site-group__count">{ungroupedSites.length}件</span>
                </div>
                <div className="site-group__body">
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
                          <th></th>
                        </tr>
                      </thead>
                      <tbody>
                        {ungroupedSites.map((site) => {
                          const isEditingThisSite =
                            !sessionEditor?.isExistingGroup &&
                            (sessionEditor?.sourceIds.includes(site.id) ?? false);
                          return (
                            <Fragment key={site.id}>
                              <tr className={
                                editingSiteId === site.id || isEditingThisSite
                                  ? 'site-editing-row' : ''
                              }>
                                <td>{site.date}</td>
                                <td className="site-col">{site.siteName}</td>
                                <td>{site.startTime}</td>
                                <td>{site.endTime}</td>
                                <td>{site.requiredPeople}人</td>
                                <td>{site.memo || '—'}</td>
                                <td className="action-cell">
                                  <button className="btn btn--sm btn--secondary"
                                    onClick={() => isEditingThisSite
                                      ? setSessionEditor(null)
                                      : openSiteSessionEditor(site)}>
                                    {isEditingThisSite ? 'キャンセル' : '会期編集'}
                                  </button>
                                  <button className="btn btn--sm btn--danger"
                                    onClick={() => deleteSite(site.id)}>
                                    削除
                                  </button>
                                </td>
                              </tr>

                              {isEditingThisSite && (
                                <tr className="site-edit-row">
                                  <td colSpan={7}>
                                    <div className="session-editor session-editor--inline">
                                      {sessionEditorContent}
                                    </div>
                                  </td>
                                </tr>
                              )}
                            </Fragment>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
