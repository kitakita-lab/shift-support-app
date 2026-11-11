import { useState, useEffect } from 'react';
import { DayPicker } from 'react-day-picker';
import type { DateRange } from 'react-day-picker';
import { ja } from 'react-day-picker/locale';
import 'react-day-picker/style.css';

interface Props {
  startDate:     string;
  endDate:       string;
  currentMonth?: string; // YYYY-MM。startDate が空のときカレンダーの表示月に使う
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

// 初期表示月: startDate > currentMonth > 今月 の優先順
function resolveMonth(startDate: string, currentMonth?: string): Date {
  if (startDate) {
    const d = toDate(startDate);
    if (d) return d;
  }
  if (currentMonth) {
    const [y, m] = currentMonth.split('-').map(Number);
    if (y && m) return new Date(y, m - 1, 1);
  }
  return new Date();
}

export default function SessionDateRangePicker({
  startDate,
  endDate,
  currentMonth,
  onChange,
}: Props) {
  // 制御型月管理: ユーザーの手動月送りを保持しつつ、
  // startDate 未設定の会期は currentMonth の変化に追従する
  const [month, setMonth] = useState<Date>(() => resolveMonth(startDate, currentMonth));

  useEffect(() => {
    // startDate 未設定（新規・空の会期）のときのみ対象月変更に追従
    if (!startDate) {
      setMonth(resolveMonth('', currentMonth));
    }
  }, [currentMonth, startDate]);

  const from     = toDate(startDate);
  const to       = toDate(endDate);
  const selected: DateRange = { from, to };

  function handleSelect(range: DateRange | undefined) {
    if (!range || !range.from) {
      onChange('', '');
      return;
    }
    const newStart = toYMD(range.from);
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
        month={month}
        onMonthChange={setMonth}
      />
    </div>
  );
}
