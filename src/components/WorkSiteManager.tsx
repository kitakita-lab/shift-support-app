import { useState } from 'react';
import { WorkSite } from '../types';

interface Props {
  workSites: WorkSite[];
  onChange: (workSites: WorkSite[]) => void;
}

function emptyForm(): Omit<WorkSite, 'id'> {
  return {
    date: '',
    siteName: '',
    startTime: '09:00',
    endTime: '18:00',
    requiredPeople: 1,
    memo: '',
  };
}

export default function WorkSiteManager({ workSites, onChange }: Props) {
  const [form, setForm] = useState(emptyForm());
  const [editId, setEditId] = useState<string | null>(null);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.date || !form.siteName.trim()) return;
    if (editId) {
      onChange(workSites.map((w) => (w.id === editId ? { ...form, id: editId } : w)));
      setEditId(null);
    } else {
      onChange([...workSites, { ...form, id: crypto.randomUUID() }]);
    }
    setForm(emptyForm());
  }

  function handleEdit(w: WorkSite) {
    setEditId(w.id);
    setForm({
      date: w.date,
      siteName: w.siteName,
      startTime: w.startTime,
      endTime: w.endTime,
      requiredPeople: w.requiredPeople,
      memo: w.memo,
    });
  }

  function handleDelete(id: string) {
    onChange(workSites.filter((w) => w.id !== id));
  }

  function handleCancel() {
    setEditId(null);
    setForm(emptyForm());
  }

  const sorted = [...workSites].sort((a, b) => a.date.localeCompare(b.date));

  return (
    <div>
      <h2>現場・必要人数管理</h2>
      <div className="card">
        <h3>{editId ? '現場編集' : '現場登録'}</h3>
        <form onSubmit={handleSubmit} className="form">
          <div className="form-row">
            <label className="form-label">日付 *</label>
            <input
              className="form-input"
              type="date"
              value={form.date}
              onChange={(e) => setForm({ ...form, date: e.target.value })}
              required
            />
          </div>

          <div className="form-row">
            <label className="form-label">現場名 *</label>
            <input
              className="form-input"
              type="text"
              value={form.siteName}
              onChange={(e) => setForm({ ...form, siteName: e.target.value })}
              placeholder="〇〇倉庫"
              required
            />
          </div>

          <div className="form-row">
            <label className="form-label">開始時間</label>
            <input
              className="form-input form-input--short"
              type="time"
              value={form.startTime}
              onChange={(e) => setForm({ ...form, startTime: e.target.value })}
            />
          </div>

          <div className="form-row">
            <label className="form-label">終了時間</label>
            <input
              className="form-input form-input--short"
              type="time"
              value={form.endTime}
              onChange={(e) => setForm({ ...form, endTime: e.target.value })}
            />
          </div>

          <div className="form-row">
            <label className="form-label">必要人数</label>
            <input
              className="form-input form-input--short"
              type="number"
              min={1}
              value={form.requiredPeople}
              onChange={(e) => setForm({ ...form, requiredPeople: Number(e.target.value) })}
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
        <h3>登録済み現場 ({workSites.length}件)</h3>
        {workSites.length === 0 ? (
          <p className="empty-msg">現場が登録されていません</p>
        ) : (
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
                {sorted.map((w) => (
                  <tr key={w.id}>
                    <td>{w.date}</td>
                    <td>{w.siteName}</td>
                    <td>{w.startTime}</td>
                    <td>{w.endTime}</td>
                    <td>{w.requiredPeople}人</td>
                    <td>{w.memo || '—'}</td>
                    <td className="action-cell">
                      <button className="btn btn--sm btn--secondary" onClick={() => handleEdit(w)}>
                        編集
                      </button>
                      <button
                        className="btn btn--sm btn--danger"
                        onClick={() => handleDelete(w.id)}
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
