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

// ─── helpers ───────────────────────────────────────────────

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

function emptyForm(): BulkForm {
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

function calcTargetDates(form: BulkForm): string[] {
  if (!form.startDate || !form.endDate || form.startDate > form.endDate) return [];
  const weekdayNums = new Set(
    WEEKDAYS.filter((w) => form.targetWeekdays.includes(w.label)).map((w) => w.day)
  );
  const excludedSet = new Set(form.excludedDates);
  const dates: string[] = [];
  const cursor = new Date(form.startDate + 'T00:00:00');
  const end = new Date(form.endDate + 'T00:00:00');
  while (cursor <= end) {
    if (weekdayNums.has(cursor.getDay())) {
      const iso = cursor.toISOString().slice(0, 10);
      if (!excludedSet.has(iso)) dates.push(iso);
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return dates;
}

function deriveWeekdays(sites: WorkSite[]): string {
  const nums = new Set(sites.map((s) => new Date(s.date + 'T00:00:00').getDay()));
  return WEEKDAYS.filter((w) => nums.has(w.day))
    .map((w) => w.label)
    .join('');
}

function deriveMonthLabel(sites: WorkSite[]): string {
  const sorted = [...sites].sort((a, b) => a.date.localeCompare(b.date));
  const first = new Date(sorted[0].date + 'T00:00:00');
  const last = new Date(sorted[sorted.length - 1].date + 'T00:00:00');
  const fy = first.getFullYear();
  const ly = last.getFullYear();
  const fm = first.getMonth() + 1;
  const lm = last.getMonth() + 1;
  const currentYear = new Date().getFullYear();
  const showYear = fy !== currentYear || ly !== currentYear;
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

interface GroupEditForm { startTime: string; endTime: string; requiredPeople: number; }
interface SiteEditForm  { date: string; startTime: string; endTime: string; requiredPeople: number; memo: string; }

interface Props {
  workSites: WorkSite[];
  onChange: (workSites: WorkSite[]) => void;
}

// ─── component ─────────────────────────────────────────────

export default function WorkSiteManager({ workSites, onChange }: Props) {
  // bulk form
  const [form, setForm]               = useState<BulkForm>(emptyForm());
  const [excludeInput, setExcludeInput] = useState('');
  const [successMsg, setSuccessMsg]   = useState('');

  // list state
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [groupEditForm, setGroupEditForm]   = useState<GroupEditForm>({ startTime: '09:00', endTime: '18:00', requiredPeople: 1 });
  const [editingSiteId, setEditingSiteId]   = useState<string | null>(null);
  const [siteEditForm, setSiteEditForm]     = useState<SiteEditForm>({ date: '', startTime: '', endTime: '', requiredPeople: 1, memo: '' });

  const targetDates = useMemo(() => calcTargetDates(form), [form]);

  // グループ化
  const { sortedGroups, ungroupedSites } = useMemo(() => {
    const grouped: Record<string, WorkSite[]> = {};
    const ungrouped: WorkSite[] = [];
    workSites.forEach((site) => {
      if (site.groupId) {
        (grouped[site.groupId] ??= []).push(site);
      } else {
        ungrouped.push(site);
      }
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

  // ── bulk form handlers ──────────────────────────────────

  function toggleWeekday(label: string) {
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
    setForm(emptyForm());
    setExcludeInput('');
    setTimeout(() => setSuccessMsg(''), 4000);
  }

  // ── group handlers ──────────────────────────────────────

  function toggleGroup(groupId: string) {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      next.has(groupId) ? next.delete(groupId) : next.add(groupId);
      return next;
    });
  }

  function startGroupEdit(groupId: string, sites: WorkSite[]) {
    setEditingGroupId(groupId);
    setGroupEditForm({ startTime: sites[0].startTime, endTime: sites[0].endTime, requiredPeople: sites[0].requiredPeople });
    setEditingSiteId(null);
  }

  function applyGroupEdit(groupId: string) {
    onChange(workSites.map((s) =>
      s.groupId === groupId ? { ...s, ...groupEditForm } : s
    ));
    setEditingGroupId(null);
  }

  function deleteGroup(groupId: string) {
    const count = workSites.filter((s) => s.groupId === groupId).length;
    if (!confirm(`このグループ（${count}件）をすべて削除します。よろしいですか？`)) return;
    onChange(workSites.filter((s) => s.groupId !== groupId));
    setExpandedGroups((p) => { const n = new Set(p); n.delete(groupId); return n; });
    if (editingGroupId === groupId) setEditingGroupId(null);
  }

  // ── site handlers ───────────────────────────────────────

  function startSiteEdit(site: WorkSite) {
    setEditingSiteId(site.id);
    setSiteEditForm({ date: site.date, startTime: site.startTime, endTime: site.endTime, requiredPeople: site.requiredPeople, memo: site.memo });
    setEditingGroupId(null);
  }

  function applySiteEdit(id: string) {
    onChange(workSites.map((s) => s.id === id ? { ...s, ...siteEditForm } : s));
    setEditingSiteId(null);
  }

  function deleteSite(id: string) {
    onChange(workSites.filter((s) => s.id !== id));
    if (editingSiteId === id) setEditingSiteId(null);
  }

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
                    onChange={() => toggleWeekday(label)} />
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
              const expanded      = expandedGroups.has(groupId);
              const editingGroup  = editingGroupId === groupId;
              return (
                <div key={groupId} className="site-group">

                  {/* グループヘッダー */}
                  <div className="site-group__header">
                    <button className="site-group__toggle" onClick={() => toggleGroup(groupId)}
                      aria-label={expanded ? '閉じる' : '展開する'}>
                      {expanded ? '▼' : '▶'}
                    </button>
                    <span className="site-group__label">{getGroupLabel(sites)}</span>
                    <span className="site-group__count">{sites.length}件</span>
                    <div className="site-group__actions">
                      <button className="btn btn--sm btn--secondary"
                        onClick={() => editingGroup ? setEditingGroupId(null) : startGroupEdit(groupId, sites)}>
                        {editingGroup ? 'キャンセル' : 'グループ編集'}
                      </button>
                      <button className="btn btn--sm btn--danger" onClick={() => deleteGroup(groupId)}>
                        グループ削除
                      </button>
                    </div>
                  </div>

                  {/* グループ一括編集パネル */}
                  {editingGroup && (
                    <div className="site-group__edit-panel">
                      <span className="edit-panel__label">{sites.length}件に一括適用：</span>
                      <div className="edit-panel__fields">
                        <label className="edit-panel__field">
                          開始時間
                          <input type="time" className="form-input form-input--short"
                            value={groupEditForm.startTime}
                            onChange={(e) => setGroupEditForm({ ...groupEditForm, startTime: e.target.value })} />
                        </label>
                        <label className="edit-panel__field">
                          終了時間
                          <input type="time" className="form-input form-input--short"
                            value={groupEditForm.endTime}
                            onChange={(e) => setGroupEditForm({ ...groupEditForm, endTime: e.target.value })} />
                        </label>
                        <label className="edit-panel__field">
                          必要人数
                          <input type="number" min={1} className="form-input form-input--short"
                            value={groupEditForm.requiredPeople}
                            onChange={(e) => setGroupEditForm({ ...groupEditForm, requiredPeople: Number(e.target.value) })} />
                        </label>
                        <button className="btn btn--primary" onClick={() => applyGroupEdit(groupId)}>
                          適用
                        </button>
                      </div>
                    </div>
                  )}

                  {/* アコーディオン：日別一覧 */}
                  {expanded && (
                    <div className="site-group__body">
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
                            {sites.map((site) => (
                              <Fragment key={site.id}>
                                <tr>
                                  <td>{site.date}</td>
                                  <td>{site.startTime}</td>
                                  <td>{site.endTime}</td>
                                  <td>{site.requiredPeople}人</td>
                                  <td>{site.memo || '—'}</td>
                                  <td className="action-cell">
                                    <button className="btn btn--sm btn--secondary"
                                      onClick={() => editingSiteId === site.id ? setEditingSiteId(null) : startSiteEdit(site)}>
                                      {editingSiteId === site.id ? 'キャンセル' : '編集'}
                                    </button>
                                    <button className="btn btn--sm btn--danger"
                                      onClick={() => deleteSite(site.id)}>
                                      削除
                                    </button>
                                  </td>
                                </tr>

                                {/* 個別インライン編集行 */}
                                {editingSiteId === site.id && (
                                  <tr className="site-edit-row">
                                    <td colSpan={6}>
                                      <div className="site-edit-form">
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
                        {ungroupedSites.map((site) => (
                          <tr key={site.id}>
                            <td>{site.date}</td>
                            <td>{site.siteName}</td>
                            <td>{site.startTime}</td>
                            <td>{site.endTime}</td>
                            <td>{site.requiredPeople}人</td>
                            <td>{site.memo || '—'}</td>
                            <td className="action-cell">
                              <button className="btn btn--sm btn--danger"
                                onClick={() => deleteSite(site.id)}>
                                削除
                              </button>
                            </td>
                          </tr>
                        ))}
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
