// 入力チェック。原則：「禁止せず、警告して選ばせる」。
// ここは警告を列挙するだけで、入力値の拒否・自動修正は一切しない。
import { AppData, Assignment, Project, Warning } from '../types';
import { assignmentHours, countParts } from './calc';
import { buildLabels, findOverlaps } from './layout';
import { listDates, num, shortDate, toMinutes } from './util';

function overlaps(a: Assignment, b: Assignment): boolean {
  if (a.date !== b.date) return false;
  const as = toMinutes(a.startTime), ae = toMinutes(a.endTime);
  const bs = toMinutes(b.startTime), be = toMinutes(b.endTime);
  if (as == null || ae == null || bs == null || be == null) return false;
  return as < be && bs < ae;
}

/**
 * これから配置しようとしている1件について、配置前に確認すべき警告を返す。
 * UI は警告があれば確認ダイアログを出し、利用者が「配置する／やめる」を選ぶ。
 */
export function checkNewAssignment(a: Assignment, project: Project, data: AppData): string[] {
  const out: string[] = [];
  const name = data.staff.find((s) => s.id === a.staffId)?.name ?? 'このスタッフ';
  if (project.assignments.some((x) => x.id !== a.id && x.staffId === a.staffId && overlaps(x, a))) {
    out.push(`${name} は同じ日・同じ時間帯にすでに配置されています。`);
  }
  for (const other of data.projects) {
    if (other.id === project.id || other.status === '中止') continue;
    if (other.assignments.some((x) => x.staffId === a.staffId && overlaps(x, a))) {
      out.push(`${name} は ${shortDate(a.date)} に別案件「${other.name}」にも配置されています。`);
    }
  }
  return out;
}

export function projectWarnings(p: Project, data: AppData): Warning[] {
  const w: Warning[] = [];
  const add = (target: string, message: string, severity: Warning['severity'] = 'warn') =>
    w.push({ target, message, severity });

  // ── 基本情報 ──
  if (!p.name.trim()) add('project:name', '案件名が未入力です。');
  if (!p.venueId) add('project:venueId', '会場が未選択です。');
  const dates = listDates(p.startDate, p.endDate);
  if (!p.startDate || !p.endDate) add('project:endDate', '期間（開始日・終了日）が未入力です。');
  else if (dates.length === 0) add('project:endDate', '終了日が開始日より前になっています。');
  if (p.contents.length === 0) add('project:contents', '実施コンテンツが未登録です。', 'info');

  // ── コンテンツ ──
  for (const pc of p.contents) {
    const c = data.contents.find((x) => x.id === pc.contentId);
    if (!c) add(`pc:${pc.id}:contentId`, 'コンテンツが未選択です。');
    if (num(pc.plannedCount) === 0) add(`pc:${pc.id}:plannedCount`, '予定個数が 0 です。材料費・売上が 0 で試算されます。');
    if (num(pc.plannedCount) < 0) add(`pc:${pc.id}:plannedCount`, '予定個数がマイナスです。');
    if (c && c.materials.length === 0) add(`pc:${pc.id}:contentId`, `「${c.name}」に材料が登録されていません（材料費 0 円で試算）。`, 'info');
  }

  // ── スタッフ配置 ──
  const dateSet = new Set(dates);
  for (const a of p.assignments) {
    const s = data.staff.find((x) => x.id === a.staffId);
    const label = `${s?.name ?? '(未選択)'} ${shortDate(a.date)}`;
    if (!s) add(`assign:${a.id}:staffId`, 'スタッフが未選択、またはマスタから削除されています。');
    if (dates.length > 0 && !dateSet.has(a.date)) add(`assign:${a.id}:date`, `${label}: 日付が案件期間の外です。`);
    const st = toMinutes(a.startTime), en = toMinutes(a.endTime);
    if (st == null || en == null) add(`assign:${a.id}:endTime`, `${label}: 開始・終了時刻が未入力です（人件費 0 円で試算）。`);
    else if (en <= st) add(`assign:${a.id}:endTime`, `${label}: 終了時刻が開始時刻以前です（人件費 0 円で試算）。`);
    else {
      const span = en - st;
      const brk = num(a.breakMinutes);
      if (brk >= span) add(`assign:${a.id}:breakMinutes`, `${label}: 休憩が勤務時間以上です。`);
      const worked = assignmentHours(a);
      // 労働基準法34条: 6時間超で45分、8時間超で60分の休憩が必要
      if (worked > 8 && brk < 60) add(`assign:${a.id}:breakMinutes`, `${label}: 実働8時間超ですが休憩が60分未満です。`);
      else if (worked > 6 && brk < 45) add(`assign:${a.id}:breakMinutes`, `${label}: 実働6時間超ですが休憩が45分未満です。`);
    }
    if (s && (a.rateOverride ?? num(s.hourlyRate)) <= 0) add(`assign:${a.id}:rate`, `${label}: 時給が 0 円です。`);
    if (p.assignments.some((x) => x.id !== a.id && x.staffId === a.staffId && a.staffId && overlaps(x, a))) {
      add(`assign:${a.id}:staffId`, `${label}: 同じ時間帯に重複して配置されています。`);
    }
    for (const other of data.projects) {
      if (other.id === p.id || other.status === '中止') continue;
      if (a.staffId && other.assignments.some((x) => x.staffId === a.staffId && overlaps(x, a))) {
        add(`assign:${a.id}:staffId`, `${label}: 別案件「${other.name}」と時間帯が重なっています。`);
      }
    }
  }
  for (const d of dates) {
    if (!p.assignments.some((a) => a.date === d)) add(`day:${d}`, `${shortDate(d)}: スタッフが1人も配置されていません。`, 'info');
  }

  // ── レイアウト ──
  const counts = countParts(p.layout);
  for (const pt of data.partTypes) {
    const c = counts.get(pt.id) ?? 0;
    if (num(pt.stockQty) > 0 && c > num(pt.stockQty)) {
      add(`part:${pt.id}`, `${pt.name}: 配置 ${c} 個が保有数 ${pt.stockQty} 個を超えています（追加手配が必要）。`);
    }
  }
  for (const it of p.layout.items) {
    if (!data.partTypes.some((t) => t.id === it.partTypeId)) {
      add(`item:${it.id}`, 'パーツマスタから削除された種別のパーツが配置されています（試算に含まれません）。');
    }
  }
  const labels = buildLabels(p.layout, data.partTypes).items;
  const ov = findOverlaps(p.layout, data.partTypes);
  if (ov.length > 0) {
    const names = ov.slice(0, 3).map(([a, b]) => `${labels.get(a.id) || 'パーツ'}×${labels.get(b.id) || 'パーツ'}`).join('、');
    add('layout:overlap', `パーツが重なっています（${ov.length}組: ${names}${ov.length > 3 ? ' ほか' : ''}）。`);
  }
  if (p.layout.env.length === 0) add('layout:env', '会場の雛形（周辺環境）が未設定です。', 'info');

  return w;
}

/** target の前方一致で警告を引く（セルの色付け用） */
export function warningsFor(ws: Warning[], target: string): Warning[] {
  return ws.filter((x) => x.target === target);
}
