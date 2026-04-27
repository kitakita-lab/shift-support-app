import { useState } from 'react';
import { Staff } from '../types';

const WEEKDAYS = ['月', '火', '水', '木', '金', '土', '日'];

interface Props {
  staff: Staff[];
  onChange: (staff: Staff[]) => void;
}

function emptyForm(): Omit<Staff, 'id'> {
  return {
    name: '',
    availableWeekdays: [...WEEKDAYS],
    requestedDaysOff: [],
    maxWorkDays: 20,
    memo: '',
  };
}

export default function StaffManager({ staff, onChange }: Props) {
  const [form, setForm] = useState(emptyForm());
  const [dayOffInput, setDayOffInput] = useState('');
  const [editId, setEditId] = useState<string | null>(null);

  function handleWeekdayToggle(day: string) {
    setForm((prev) => ({
      ...prev,
      availableWeekdays: prev.availableWeekdays.includes(day)
        ? prev.availableWeekdays.filter((d) => d !== day)
        : [...prev.availableWeekdays, day],
    }));
  }

  function handleAddDayOff() {
    if (!dayOffInput) return;
    if (form.requestedDaysOff.includes(dayOffInput)) return;
    setForm((prev) => ({
      ...prev,
      requestedDaysOff: [...prev.requestedDaysOff, dayOffInput].sort(),
    }));
    setDayOffInput('');
  }

  function handleRemoveDayOff(d: string) {
    setForm((prev) => ({
      ...prev,
      requestedDaysOff: prev.requestedDaysOff.filter((x) => x !== d),
    }));
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) return;
    if (editId) {
      onChange(staff.map((s) => (s.id === editId ? { ...form, id: editId } : s)));
      setEditId(null);
    } else {
      onChange([...staff, { ...form, id: crypto.randomUUID() }]);
    }
    setForm(emptyForm());
    setDayOffInput('');
  }

  function handleEdit(s: Staff) {
    setEditId(s.id);
    setForm({
      name: s.name,
      availableWeekdays: s.availableWeekdays,
      requestedDaysOff: s.requestedDaysOff,
      maxWorkDays: s.maxWorkDays,
      memo: s.memo,
    });
  }

  function handleDelete(id: string) {
    onChange(staff.filter((s) => s.id !== id));
  }

  function handleCancel() {
    setEditId(null);
    setForm(emptyForm());
    setDayOffInput('');
  }

  return (
    <div>
      <h2>スタッフ管理</h2>
      <div className="card">
        <h3>{editId ? 'スタッフ編集' : 'スタッフ登録'}</h3>
        <form onSubmit={handleSubmit} className="form">
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
            <label className="form-label">希望休</label>
            <div className="day-off-group">
              <div className="day-off-input-row">
                <input
                  className="form-input"
                  type="date"
                  value={dayOffInput}
                  onChange={(e) => setDayOffInput(e.target.value)}
                />
                <button type="button" className="btn btn--secondary" onClick={handleAddDayOff}>
                  追加
                </button>
              </div>
              <div className="tag-list">
                {form.requestedDaysOff.map((d) => (
                  <span key={d} className="tag">
                    {d}
                    <button
                      type="button"
                      className="tag__remove"
                      onClick={() => handleRemoveDayOff(d)}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
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
            <table className="data-table">
              <thead>
                <tr>
                  <th>名前</th>
                  <th>勤務可能曜日</th>
                  <th>希望休</th>
                  <th>最大日数</th>
                  <th>メモ</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {staff.map((s) => (
                  <tr key={s.id}>
                    <td>{s.name}</td>
                    <td>{s.availableWeekdays.join('・')}</td>
                    <td>{s.requestedDaysOff.join(', ') || '—'}</td>
                    <td>{s.maxWorkDays}日</td>
                    <td>{s.memo || '—'}</td>
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
