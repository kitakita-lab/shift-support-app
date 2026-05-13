import { DayPicker } from 'react-day-picker';
import type { DateRange } from 'react-day-picker';
import { ja } from 'react-day-picker/locale';
import 'react-day-picker/style.css';

interface Props {
  startDate: string;
  endDate:   string;
  onChange: (startDate: string, endDate: string) => void;
}

function toDate(s: string): Date | undefined {
  if (!s) return undefined;
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function toYMD(d: Date): string {
  const y  = d.getFullYear();
  const m  = String(d.getMonth() + 1).padStart(2, '0');
  const dy = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dy}`;
}

function fmtJp(dateStr: string): string {
  if (!dateStr) return '';
  const [y, m, d] = dateStr.split('-').map(Number);
  const dow = ['日', '月', '火', '水', '木', '金', '土'][new Date(y, m - 1, d).getDay()];
  return `${y}/${m}/${d}（${dow}）`;
}

export default function SessionDateRangePicker({ startDate, endDate, onChange }: Props) {
  const from     = toDate(startDate);
  const to       = toDate(endDate);
  const selected: DateRange = { from, to };

  function handleSelect(range: DateRange | undefined) {
    if (!range || !range.from) {
      onChange('', '');
      return;
    }
    const newStart = toYMD(range.from);
    // to が未設定 → 開始日のみ選択中（終了日を待機）
    // to が設定済み → 範囲確定（同日なら単日案件）
    const newEnd = range.to ? toYMD(range.to) : '';
    onChange(newStart, newEnd);
  }

  const label =
    startDate && endDate
      ? startDate === endDate
        ? `${fmtJp(startDate)}（1日間）`
        : `${fmtJp(startDate)} 〜 ${fmtJp(endDate)}`
      : startDate
      ? `${fmtJp(startDate)} → 終了日を選択`
      : '開始日をタップしてください';

  return (
    <div className="sdrp">
      <div className="sdrp__label">{label}</div>
      <DayPicker
        mode="range"
        selected={selected}
        onSelect={handleSelect}
        locale={ja}
        numberOfMonths={1}
      />
    </div>
  );
}
