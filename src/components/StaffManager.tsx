import { useState, useEffect } from 'react';
import { Staff, WorkSite } from '../types';
import { sortStaff, nextStaffNo } from '../utils/staffUtils';

const WEEKDAYS = ['月', '火', '水', '木', '金', '土', '日'];

interface Props {
  staff: Staff[];
  workSites: WorkSite[];
  onChange: (staff: Staff[]) => void;
}

function emptyForm(staff: Staff[]): Omit<Staff, 'id'> {
  return {
    staffNo: nextStaffNo(staff),
    name: '',
    availableWeekdays: [...WEEKDAYS],
    requestedDaysOff: [],
    maxWorkDays: 20,
    memo: '',
    preferredWorkSites: [],
  };
}

function formatPreferredSites(sites: string[]): string {
  if (sites.length === 0) return '—';
  const MAX = 2;
  const shown = sites.slice(0, MAX);
  return sites.length <= MAX
    ? shown.join('、')
    : `${shown.join('、')} +${sites.length - MAX}件`;
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

export default function StaffManager({ staff, workSites, onChange }: Props) {
  const [form, setForm] = useState<Omit<Staff, 'id'>>(() => emptyForm(staff));
  const [editId, setEditId] = useState<string | null>(null);
  const [currentMonth, setCurrentMonth] = useState(() => toYearMonth(new Date()));
  const [editingNos, setEditingNos] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!editId) setForm((prev) => ({ ...prev, staffNo: nextStaffNo(staff) }));
  }, [staff, editId]);

  function handleWeekdayToggle(day: string) {
    setForm((prev) => ({
      ...prev,
      availableWeekdays: prev.availableWeekdays.includes(day)
        ? prev.availableWeekdays.filter((d) => d !== day)
        : [...prev.availableWeekdays, day],
    }));
  }

  function togglePreferredSite(name: string) {
    setForm((prev) => ({
      ...prev,
      preferredWorkSites: prev.preferredWorkSites.includes(name)
        ? prev.preferredWorkSites.filter((n) => n !== name)
        : [...prev.preferredWorkSites, name],
    }));
  }

  const uniqueSiteNames = [...new Set(workSites.map((w) => w.siteName))].sort();

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
  }

  function handleEdit(s: Staff) {
    setEditId(s.id);
    setForm({
      staffNo: s.staffNo,
      name: s.name,
      availableWeekdays: s.availableWeekdays,
      requestedDaysOff: s.requestedDaysOff,
      maxWorkDays: s.maxWorkDays,
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
            <label className="form-label">勤務可能曜日</label>
            <div className="weekday-group">
              {WEEKDAYS.map((day) => (
                <label key={day} className="weekday-label">
                  <input
                    type="checkbox"
                    checked={form.availableWeekdays.includes(day)}
                    onChange={() => handleWeekdayToggle(day)}
                  />
                  {day}
                </label>
              ))}
            </div>
          </div>

          <div className="form-row">
            <label className="form-label">最大勤務日数</label>
            <input
              className="form-input form-input--short"
              type="number"
              min={1}
              max={31}
              value={form.maxWorkDays}
              onChange={(e) => setForm({ ...form, maxWorkDays: Number(e.target.value) })}
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

          <div className="form-row form-row--top">
            <label className="form-label">優先現場</label>
            <div>
              {uniqueSiteNames.length === 0 ? (
                <span className="empty-chips">現場が登録されていません</span>
              ) : (
                <div className="site-chips">
                  {uniqueSiteNames.map((name) => (
                    <button
                      key={name}
                      type="button"
                      className={`site-chip${form.preferredWorkSites.includes(name) ? ' site-chip--active' : ''}`}
                      onClick={() => togglePreferredSite(name)}
                    >
                      {name}
                    </button>
                  ))}
                </div>
              )}
              <p className="section-desc" style={{ marginTop: '4px' }}>
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
          <div className="table-wrapper">
            <table className="data-table data-table--staff">
              <thead>
                <tr>
                  <th>No.</th>
                  <th>名前</th>
                  <th>勤務可能曜日</th>
                  <th>希望休（{monthLabel}）</th>
                  <th>最大日数</th>
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
                    <td>{s.availableWeekdays.join('・')}</td>
                    <td>{formatDaysOff(s.requestedDaysOff, currentMonth)}</td>
                    <td>{s.maxWorkDays}日</td>
                    <td>{s.memo || '—'}</td>
                    <td>{formatPreferredSites(s.preferredWorkSites)}</td>
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
        )}
      </div>
    </div>
  );
}
