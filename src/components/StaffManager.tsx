import { useState, useEffect, useMemo } from 'react';
import { Staff, WorkSite } from '../types';
import { sortStaff, nextStaffNo } from '../utils/staffUtils';

interface Props {
  staff: Staff[];
  workSites: WorkSite[];
  onChange: (staff: Staff[]) => void;
  selectedMonth: string;
}

function emptyForm(staff: Staff[]): Omit<Staff, 'id'> {
  return {
    staffNo: nextStaffNo(staff),
    name: '',
    availableWeekdays: [],
    requestedDaysOff: [],
    maxWorkDays: 20,
    maxConsecutiveDays: 5,
    memo: '',
    preferredWorkSites: [],
  };
}

function formatPreferredSites(sites: string[]): string {
  if (sites.length === 0) return '—';
  return sites.join('、');
}

function toYearMonth(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function buildCalendarDays(yearMonth: string): (string | null)[] {
  const [y, m] = yearMonth.split('-').map(Number);
  const firstDay = new Date(y, m - 1, 1).getDay();
  const daysInMonth = new Date(y, m, 0).getDate();
  const cells: (string | null)[] = Array(firstDay).fill(null);
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push(`${yearMonth}-${String(d).padStart(2, '0')}`);
  }
  return cells;
}

// MM/DD 形式に変換し、3件超は「他N件」で省略
function formatDaysOff(days: string[], yearMonth: string): string {
  const filtered = days.filter((d) => d.startsWith(yearMonth));
  if (filtered.length === 0) return '—';
  const MAX = 3;
  const shown = filtered.slice(0, MAX).map((d) => d.slice(5).replace('-', '/'));
  return filtered.length <= MAX
    ? shown.join('、')
    : `${shown.join('、')} 他${filtered.length - MAX}件`;
}

const DOW_LABELS = ['日', '月', '火', '水', '木', '金', '土'];

interface CalendarProps {
  yearMonth: string;
  onMonthChange: (yearMonth: string) => void;
  daysOff: string[];
  onChange: (days: string[]) => void;
}

function DaysOffCalendar({ yearMonth, onMonthChange, daysOff, onChange }: CalendarProps) {
  const cells = buildCalendarDays(yearMonth);
  const _now  = new Date();
  const pad   = (n: number) => n.toString().padStart(2, '0');
  const today = `${_now.getFullYear()}-${pad(_now.getMonth() + 1)}-${pad(_now.getDate())}`;
  const offSet = new Set(daysOff);

  function changeMonth(ym: string) {
    onMonthChange(ym);
  }

  function toggle(date: string) {
    if (offSet.has(date)) {
      onChange(daysOff.filter((d) => d !== date).sort());
    } else {
      onChange([...daysOff, date].sort());
    }
  }

  return (
    <div className="cal">
      <div className="cal__nav">
        <button
          type="button"
          className="btn btn--sm btn--secondary"
          onClick={() => {
            const [y, m] = yearMonth.split('-').map(Number);
            changeMonth(toYearMonth(new Date(y, m - 2, 1)));
          }}
        >
          ‹
        </button>
        <input
          type="month"
          className="cal__month-input"
          value={yearMonth}
          onChange={(e) => changeMonth(e.target.value)}
        />
        <button
          type="button"
          className="btn btn--sm btn--secondary"
          onClick={() => {
            const [y, m] = yearMonth.split('-').map(Number);
            changeMonth(toYearMonth(new Date(y, m, 1)));
          }}
        >
          ›
        </button>
      </div>
      <div className="cal__grid">
        {DOW_LABELS.map((d) => (
          <div
            key={d}
            className={`cal__dow${d === '日' ? ' cal__dow--sun' : d === '土' ? ' cal__dow--sat' : ''}`}
          >
            {d}
          </div>
        ))}
        {cells.map((date, i) =>
          date === null ? (
            <div key={`empty-${i}`} className="cal__day cal__day--empty" />
          ) : (
            <button
              key={date}
              type="button"
              className={[
                'cal__day',
                offSet.has(date) ? 'cal__day--off' : '',
                date === today ? 'cal__day--today' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              onClick={() => toggle(date)}
            >
              {parseInt(date.slice(8), 10)}
            </button>
          )
        )}
      </div>
      {daysOff.filter((d) => d.startsWith(yearMonth)).length > 0 && (
        <div className="cal__summary">
          {daysOff
            .filter((d) => d.startsWith(yearMonth))
            .map((d) => (
              <span key={d} className="tag">
                {d.slice(5)}
                <button type="button" className="tag__remove" onClick={() => toggle(d)}>
                  ×
                </button>
              </span>
            ))}
        </div>
      )}
    </div>
  );
}

export default function StaffManager({ staff, workSites, onChange, selectedMonth }: Props) {
  const [form, setForm] = useState<Omit<Staff, 'id'>>(() => emptyForm(staff));
  const [editId, setEditId] = useState<string | null>(null);
  const [currentMonth, setCurrentMonth] = useState(() => selectedMonth);
  const [editingNos, setEditingNos] = useState<Record<string, string>>({});
  const [addSiteOpen, setAddSiteOpen] = useState(false);
  const [siteSearch, setSiteSearch] = useState('');

  // siteName → clientNames[] のルックアップ（検索フィルタ用）
  const siteClientMap = useMemo(() => {
    const map = new Map<string, string[]>();
    workSites.forEach((w) => {
      if (!map.has(w.siteName)) map.set(w.siteName, []);
      const c = w.clientName?.trim();
      if (c && !map.get(w.siteName)!.includes(c)) map.get(w.siteName)!.push(c);
    });
    return map;
  }, [workSites]);

  useEffect(() => {
    if (!editId) setForm((prev) => ({ ...prev, staffNo: nextStaffNo(staff) }));
  }, [staff, editId]);

  useEffect(() => {
    setCurrentMonth(selectedMonth);
  }, [selectedMonth]);

  function togglePreferredSite(name: string) {
    setForm((prev) => ({
      ...prev,
      preferredWorkSites: prev.preferredWorkSites.includes(name)
        ? prev.preferredWorkSites.filter((n) => n !== name)
        : [...prev.preferredWorkSites, name],
    }));
  }

  const uniqueSiteNames = [...new Set(workSites.map((w) => w.siteName))].sort();
  const unselectedSites = uniqueSiteNames.filter((n) => !form.preferredWorkSites.includes(n));

  // 検索クエリで siteName・clientName の両方を照合して絞り込む
  const filteredUnselectedSites = siteSearch.trim()
    ? unselectedSites.filter((name) => {
        const q = siteSearch.trim().toLowerCase();
        if (name.toLowerCase().includes(q)) return true;
        return siteClientMap.get(name)?.some((c) => c.toLowerCase().includes(q)) ?? false;
      })
    : unselectedSites;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) return;
    if (editId) {
      onChange(sortStaff(staff.map((s) => (s.id === editId ? { ...form, id: editId } : s))));
      setEditId(null);
    } else {
      onChange(sortStaff([...staff, { ...form, id: crypto.randomUUID() }]));
    }
    setForm(emptyForm(staff));
    setAddSiteOpen(false);
    setSiteSearch('');
  }

  function handleEdit(s: Staff) {
    setEditId(s.id);
    setForm({
      staffNo: s.staffNo,
      name: s.name,
      availableWeekdays: s.availableWeekdays,
      requestedDaysOff: s.requestedDaysOff,
      maxWorkDays: s.maxWorkDays,
      maxConsecutiveDays: s.maxConsecutiveDays ?? 5,
      memo: s.memo,
      preferredWorkSites: s.preferredWorkSites,
    });
  }

  function handleDelete(id: string) {
    onChange(staff.filter((s) => s.id !== id));
  }

  function handleCancel() {
    setEditId(null);
    setForm(emptyForm(staff));
    setAddSiteOpen(false);
    setSiteSearch('');
  }

  function handleStaffNoChange(id: string, value: string) {
    setEditingNos((prev) => ({ ...prev, [id]: value }));
  }

  function handleStaffNoBlur(id: string) {
    const next = (editingNos[id] ?? '').trim();
    setEditingNos((prev) => { const n = { ...prev }; delete n[id]; return n; });
    const original = staff.find((s) => s.id === id)?.staffNo ?? '';
    if (next === original || next === '') return;
    onChange(sortStaff(staff.map((s) => s.id === id ? { ...s, staffNo: next } : s)));
  }

  const [listYear, listMon] = currentMonth.split('-');
  const monthLabel = `${listYear}年${parseInt(listMon, 10)}月`;

  return (
    <div>
      <h2>スタッフ管理</h2>

      <div className="card">
        <h3>{editId ? 'スタッフ編集' : 'スタッフ登録'}</h3>
        <form onSubmit={handleSubmit} className="form">
          <h4 className="form-section-title">基本情報</h4>

          <div className="form-row">
            <label className="form-label">スタッフNo.</label>
            <input
              className="form-input form-input--short"
              type="text"
              value={form.staffNo}
              onChange={(e) => setForm({ ...form, staffNo: e.target.value })}
              placeholder="1"
            />
          </div>

          <div className="form-row">
            <label className="form-label">名前 *</label>
            <input
              className="form-input"
              type="text"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="山田 太郎"
              required
            />
          </div>

          <div className="form-row">
            <label className="form-label">メモ</label>
            <input
              className="form-input"
              type="text"
              value={form.memo}
              onChange={(e) => setForm({ ...form, memo: e.target.value })}
              placeholder="任意"
            />
          </div>

          <div className="form-row">
            <label className="form-label">最大連勤日数</label>
            <input
              className="form-input form-input--short"
              type="number"
              min={1}
              value={form.maxConsecutiveDays ?? 5}
              onChange={(e) => {
                const v = parseInt(e.target.value, 10);
                setForm({ ...form, maxConsecutiveDays: v >= 1 ? v : 5 });
              }}
              onBlur={(e) => {
                const v = parseInt(e.target.value, 10);
                if (isNaN(v) || v < 1) setForm({ ...form, maxConsecutiveDays: 5 });
              }}
            />
            <span className="form-unit">日</span>
          </div>

          <div className="form-row form-row--top">
            <label className="form-label">優先現場</label>
            <div className="preferred-editor">
              {uniqueSiteNames.length === 0 ? (
                <span className="empty-chips">現場が登録されていません</span>
              ) : (
                <>
                  {/* 上段：選択済み */}
                  <div className="preferred-selected">
                    {form.preferredWorkSites.length === 0 ? (
                      <span className="preferred-none">なし</span>
                    ) : (
                      <div className="site-chips">
                        {form.preferredWorkSites.map((name) => (
                          <span key={name} className="site-chip site-chip--selected">
                            <span className="site-chip__name">{name}</span>
                            <button
                              type="button"
                              className="site-chip__remove"
                              onClick={() => togglePreferredSite(name)}
                              aria-label={`${name}を外す`}
                            >×</button>
                          </span>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* 下段：未選択（トグル） */}
                  {unselectedSites.length > 0 && (
                    <div className="preferred-add">
                      <button
                        type="button"
                        className="preferred-add__toggle"
                        onClick={() => {
                          setAddSiteOpen((v) => {
                            if (v) setSiteSearch('');
                            return !v;
                          });
                        }}
                      >
                        ＋ 現場を追加
                        <span className="preferred-add__chevron">{addSiteOpen ? '▲' : '▼'}</span>
                      </button>
                      {addSiteOpen && (
                        <div className="preferred-add__panel">
                          <input
                            type="text"
                            className="preferred-add__search"
                            placeholder="現場名・クライアント名で絞り込み"
                            value={siteSearch}
                            onChange={(e) => setSiteSearch(e.target.value)}
                          />
                          <div className="site-chips preferred-add__chips">
                            {filteredUnselectedSites.length > 0 ? (
                              filteredUnselectedSites.map((name) => (
                                <button
                                  key={name}
                                  type="button"
                                  className="site-chip"
                                  onClick={() => togglePreferredSite(name)}
                                >
                                  {name}
                                </button>
                              ))
                            ) : (
                              <span className="preferred-none">
                                {siteSearch.trim() ? '該当なし' : '追加できる現場がありません'}
                              </span>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}
              <p className="section-desc" style={{ marginTop: '6px' }}>
                シフト自動作成時、同条件なら優先的に割り当てます
              </p>
            </div>
          </div>

          <h4 className="form-section-title">月別希望休カレンダー</h4>
          <p className="section-desc">日付をクリックして希望休を登録・解除できます</p>

          <DaysOffCalendar
            yearMonth={currentMonth}
            onMonthChange={setCurrentMonth}
            daysOff={form.requestedDaysOff}
            onChange={(days) => setForm((prev) => ({ ...prev, requestedDaysOff: days }))}
          />

          <div className="form-actions">
            <button type="submit" className="btn btn--primary">
              {editId ? '更新' : '登録'}
            </button>
            {editId && (
              <button type="button" className="btn btn--secondary" onClick={handleCancel}>
                キャンセル
              </button>
            )}
          </div>
        </form>
      </div>

      <div className="card">
        <h3>登録済みスタッフ ({staff.length}件)</h3>
        {staff.length === 0 ? (
          <p className="empty-msg">スタッフが登録されていません</p>
        ) : (
          <>
          {/* PC：テーブル表示 */}
          <div className="table-wrapper staff-table-wrapper">
            <table className="data-table data-table--staff">
              <thead>
                <tr>
                  <th>No.</th>
                  <th>名前</th>
                  <th>希望休（{monthLabel}）</th>
                  <th>メモ</th>
                  <th>優先現場</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {staff.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <input
                        className="staffno-input"
                        type="text"
                        value={editingNos[s.id] ?? s.staffNo}
                        placeholder="—"
                        onChange={(e) => handleStaffNoChange(s.id, e.target.value)}
                        onBlur={() => handleStaffNoBlur(s.id)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                        }}
                      />
                    </td>
                    <td className="name-cell">{s.name}</td>
                    <td>{formatDaysOff(s.requestedDaysOff, currentMonth)}</td>
                    <td>{s.memo || '—'}</td>
                    <td className="preferred-sites-cell">{formatPreferredSites(s.preferredWorkSites)}</td>
                    <td className="action-cell">
                      <button className="btn btn--sm btn--secondary" onClick={() => handleEdit(s)}>
                        編集
                      </button>
                      <button
                        className="btn btn--sm btn--danger"
                        onClick={() => handleDelete(s.id)}
                      >
                        削除
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* モバイル：カード表示 */}
          <div className="staff-card-list">
            {staff.map((s) => {
              const daysOffText = formatDaysOff(s.requestedDaysOff, currentMonth);
              const hasDaysOff  = daysOffText !== '—';
              return (
                <div key={s.id} className="staff-card">
                  {/* ── ヘッダー（名前左・No右）── */}
                  <div className="staff-card__header">
                    <span className="staff-card__name">{s.name}</span>
                    <span className="staff-card__no">{s.staffNo || '—'}</span>
                  </div>

                  {/* ── 本文 ── */}
                  <div className="staff-card__body">
                    {/* 希望休：あり→赤、なし→グレー */}
                    <div className={`staff-card__daysoff${hasDaysOff ? ' staff-card__daysoff--has' : ''}`}>
                      <span className="staff-card__label">希望休</span>
                      <span className="staff-card__daysoff-value">
                        {hasDaysOff ? daysOffText : '希望休なし'}
                      </span>
                    </div>

                    {/* 優先現場：チップ形式 */}
                    <div className="staff-card__row">
                      <span className="staff-card__label">優先現場</span>
                      <div className="staff-card__chips">
                        {s.preferredWorkSites.length === 0 ? (
                          <span className="staff-card__value">—</span>
                        ) : (
                          s.preferredWorkSites.map((site) => (
                            <span key={site} className="staff-card__chip">{site}</span>
                          ))
                        )}
                      </div>
                    </div>

                    {/* メモ：空なら非表示 */}
                    {s.memo && (
                      <div className="staff-card__row staff-card__row--memo">
                        <span className="staff-card__label">メモ</span>
                        <span className="staff-card__value staff-card__value--memo">{s.memo}</span>
                      </div>
                    )}
                  </div>

                  {/* ── アクション（右寄せ）── */}
                  <div className="staff-card__actions">
                    <button className="btn btn--sm btn--secondary" onClick={() => handleEdit(s)}>
                      編集
                    </button>
                    <button className="btn btn--sm btn--danger" onClick={() => handleDelete(s.id)}>
                      削除
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
          </>
        )}
      </div>
    </div>
  );
}
