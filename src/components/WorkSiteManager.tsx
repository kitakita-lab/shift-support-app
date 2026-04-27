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
  if (!form.startDate || !form.endDate) return [];
  if (form.startDate > form.endDate) return [];

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

interface Props {
  workSites: WorkSite[];
  onChange: (workSites: WorkSite[]) => void;
}

export default function WorkSiteManager({ workSites, onChange }: Props) {
  const [form, setForm] = useState<BulkForm>(emptyForm());
  const [excludeInput, setExcludeInput] = useState('');
  const [successMsg, setSuccessMsg] = useState('');

  const targetDates = useMemo(() => calcTargetDates(form), [form]);

  function handleWeekdayToggle(label: string) {
    setForm((prev) => ({
      ...prev,
      targetWeekdays: prev.targetWeekdays.includes(label)
        ? prev.targetWeekdays.filter((d) => d !== label)
        : [...prev.targetWeekdays, label],
    }));
  }

  function handleAddExclude() {
    if (!excludeInput) return;
    if (form.excludedDates.includes(excludeInput)) return;
    setForm((prev) => ({
      ...prev,
      excludedDates: [...prev.excludedDates, excludeInput].sort(),
    }));
    setExcludeInput('');
  }

  function handleRemoveExclude(d: string) {
    setForm((prev) => ({
      ...prev,
      excludedDates: prev.excludedDates.filter((x) => x !== d),
    }));
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.siteName.trim() || targetDates.length === 0) return;

    const newSites: WorkSite[] = targetDates.map((date) => ({
      id: crypto.randomUUID(),
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

  function handleDelete(id: string) {
    onChange(workSites.filter((w) => w.id !== id));
  }

  const sorted = [...workSites].sort((a, b) => a.date.localeCompare(b.date));

  const isReady = form.siteName.trim() !== '' && targetDates.length > 0;

  return (
    <div>
      <h2>現場・必要人数管理</h2>

      <div className="card">
        <h3>現場を期間で一括登録</h3>
        <p className="section-desc">
          現場名・期間・曜日を指定するだけで、1ヶ月分の現場日程をまとめて作成できます。
        </p>

        <form onSubmit={handleSubmit} className="form">
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
            <label className="form-label">開始日 *</label>
            <input
              className="form-input form-input--short"
              type="date"
              value={form.startDate}
              onChange={(e) => setForm({ ...form, startDate: e.target.value })}
              required
            />
          </div>

          <div className="form-row">
            <label className="form-label">終了日 *</label>
            <input
              className="form-input form-input--short"
              type="date"
              value={form.endDate}
              onChange={(e) => setForm({ ...form, endDate: e.target.value })}
              required
            />
          </div>

          <div className="form-row">
            <label className="form-label">対象曜日 *</label>
            <div className="weekday-group">
              {WEEKDAYS.map(({ label }) => (
                <label key={label} className="weekday-label">
                  <input
                    type="checkbox"
                    checked={form.targetWeekdays.includes(label)}
                    onChange={() => handleWeekdayToggle(label)}
                  />
                  {label}
                </label>
              ))}
            </div>
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
            <label className="form-label">除外日</label>
            <div className="day-off-group">
              <div className="day-off-input-row">
                <input
                  className="form-input"
                  type="date"
                  value={excludeInput}
                  onChange={(e) => setExcludeInput(e.target.value)}
                />
                <button type="button" className="btn btn--secondary" onClick={handleAddExclude}>
                  追加
                </button>
              </div>
              {form.excludedDates.length > 0 && (
                <div className="tag-list">
                  {form.excludedDates.map((d) => (
                    <span key={d} className="tag tag--exclude">
                      {d}
                      <button
                        type="button"
                        className="tag__remove"
                        onClick={() => handleRemoveExclude(d)}
                      >
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
            <input
              className="form-input"
              type="text"
              value={form.memo}
              onChange={(e) => setForm({ ...form, memo: e.target.value })}
              placeholder="任意"
            />
          </div>

          {/* 作成予定件数プレビュー */}
          <div className={`preview-count${targetDates.length > 0 ? ' preview-count--ready' : ''}`}>
            {form.startDate && form.endDate && form.startDate > form.endDate ? (
              <span className="preview-count__error">終了日は開始日以降を指定してください</span>
            ) : targetDates.length > 0 ? (
              <>
                <span className="preview-count__num">{targetDates.length}</span>
                <span className="preview-count__text">件の現場日程が作成されます</span>
              </>
            ) : (
              <span className="preview-count__empty">
                期間・曜日を選択すると作成件数が表示されます
              </span>
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
