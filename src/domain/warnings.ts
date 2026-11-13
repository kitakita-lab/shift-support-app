// 入力チェック。原則：「禁止せず、警告して選ばせる」。
// ここは警告を列挙するだけで、入力値の拒否・自動修正は一切しない。
import { AppData, Assignment, PlacedItem, Project, Warning } from '../types';
import { assignmentHours, countParts, countSeats, seatDemand } from './calc';
import { isJcos } from './jcos';
import { buildLabels, findOverlaps, itemSize } from './layout';
import { contestedReportDays, syncStaleness, unmatchedGaps } from './report';
import { MAX_DAYS, daySpan, listDates, num, shortDate, toMinutes } from './util';

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
  // 中止の案件は実際には稼働しないので、掛け持ちの相手にも当事者にもしない
  if (project.status === '中止') return out;
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
  // JCOS 案件（請求と実費を分ける収支）では、汎用の試算にだけ関係する確認（時給・材料マスタ・スタッフ配置の有無）は出さない
  const jcos = isJcos(p);

  // ── 基本情報 ──
  if (!p.name.trim()) add('project:name', '案件名が未入力です。');
  if (!p.venueId) add('project:venueId', '会場が未選択です。');
  else if (!data.venues.some((v) => v.id === p.venueId)) add('project:venueId', '会場がマスタから削除されています（選び直してください）。');
  const dates = listDates(p.startDate, p.endDate);
  if (!p.startDate || !p.endDate) add('project:endDate', '期間（開始日・終了日）が未入力です。');
  else if (dates.length === 0) add('project:endDate', '終了日が開始日より前になっています。');
  else if (daySpan(p.startDate, p.endDate) > MAX_DAYS) {
    add('project:endDate', `期間が ${MAX_DAYS} 日を超えています（${daySpan(p.startDate, p.endDate)} 日）。試算と配置表は最初の ${MAX_DAYS} 日分だけで計算されます。年の入力を確認してください。`);
  }
  if (p.contents.length === 0) add('project:contents', '実施コンテンツが未登録です。', 'info');

  // ── コンテンツ ──
  for (const pc of p.contents) {
    const c = data.contents.find((x) => x.id === pc.contentId);
    if (!c) add(`pc:${pc.id}:contentId`, 'コンテンツが未選択です。');
    if (num(pc.plannedCount) === 0) add(`pc:${pc.id}:plannedCount`, jcos ? '予定個数が 0 です。見込みの材料原価が 0 円で計算されます。' : '予定個数が 0 です。材料費・売上が 0 で試算されます。');
    if (num(pc.plannedCount) < 0) add(`pc:${pc.id}:plannedCount`, '予定個数がマイナスです。');
    if (pc.maxTurns != null && num(pc.maxTurns) < 0) add(`pc:${pc.id}:maxTurns`, '上限回転数がマイナスです（席数の確認には使われません）。');
    // 一部のコンテンツにだけ上限回転数が入っている場合、未入力のものは席数の確認に入らない。見落としやすいので参考として知らせる
    else if (num(pc.maxTurns) <= 0 && num(pc.plannedCount) > 0 && p.contents.some((x) => num(x.maxTurns) > 0)) {
      add(`pc:${pc.id}:maxTurns`, `${c?.name ?? 'このコンテンツ'}: 上限回転数が未入力のため、制作席の過不足の確認には含めていません。`, 'info');
    }
    if (c && c.materials.length === 0 && !jcos) add(`pc:${pc.id}:contentId`, `「${c.name}」に材料が登録されていません（材料費 0 円で試算）。`, 'info');
  }

  // ── スタッフ配置 ──
  const dateSet = new Set(dates);
  for (const a of p.assignments) {
    const s = data.staff.find((x) => x.id === a.staffId);
    const label = `${s?.name ?? '(未選択)'} ${shortDate(a.date)}`;
    if (!s) add(`assign:${a.id}:staffId`, 'スタッフが未選択、またはマスタから削除されています。');
    if (dates.length > 0 && !dateSet.has(a.date)) add(`assign:${a.id}:date`, `${label}: 日付が案件期間の外です。`);
    const st = toMinutes(a.startTime), en = toMinutes(a.endTime);
    // 実働 0 時間でも交通費は試算に入る（calc.ts laborLine）。警告文もそれに合わせる
    if (st == null || en == null) add(`assign:${a.id}:endTime`, `${label}: 開始・終了時刻が未入力です（賃金 0 円で試算。交通費は計上されます）。`);
    else if (en <= st) add(`assign:${a.id}:endTime`, `${label}: 終了時刻が開始時刻以前です（賃金 0 円で試算。交通費は計上されます）。`);
    else {
      const span = en - st;
      const brk = num(a.breakMinutes);
      if (brk < 0) add(`assign:${a.id}:breakMinutes`, `${label}: 休憩がマイナスです（実働時間が実際より長く計算されます）。`);
      else if (brk >= span) add(`assign:${a.id}:breakMinutes`, `${label}: 休憩が勤務時間以上です。`);
      const worked = assignmentHours(a);
      // 労働基準法34条: 6時間超で45分、8時間超で60分の休憩が必要
      if (brk >= 0 && worked > 8 && brk < 60) add(`assign:${a.id}:breakMinutes`, `${label}: 実働8時間超ですが休憩が60分未満です。`);
      else if (brk >= 0 && worked > 6 && brk < 45) add(`assign:${a.id}:breakMinutes`, `${label}: 実働6時間超ですが休憩が45分未満です。`);
    }
    if (s && !jcos && (a.rateOverride ?? num(s.hourlyRate)) <= 0) add(`assign:${a.id}:rate`, `${label}: 時給が 0 円以下です。`);
    if (p.assignments.some((x) => x.id !== a.id && x.staffId === a.staffId && a.staffId && overlaps(x, a))) {
      add(`assign:${a.id}:staffId`, `${label}: 同じ時間帯に重複して配置されています。`);
    }
    for (const other of data.projects) {
      // 中止の案件は掛け持ちの相手にも当事者にもしない
      if (other.id === p.id || other.status === '中止' || p.status === '中止') continue;
      if (a.staffId && other.assignments.some((x) => x.staffId === a.staffId && overlaps(x, a))) {
        add(`assign:${a.id}:staffId`, `${label}: 別案件「${other.name}」と時間帯が重なっています。`);
      }
    }
  }
  for (const d of dates) {
    if (!jcos && !p.assignments.some((a) => a.date === d)) add(`day:${d}`, `${shortDate(d)}: スタッフが1人も配置されていません。`, 'info');
  }

  // ── JCOS 案件: 条件と、日報の同期で確認が必要なもの ──
  if (jcos) {
    const t = p.jcos!;
    if (num(t.unitCost) <= 0) add('jcos:unitCost', '材料原価（1 個あたり）が 0 円以下です。材料原価が 0 円で計算されます。');
    if (num(t.billLaborPerDay) < 0 || num(t.billMaterialPerDay) < 0 || num(t.partTimerPerDay) < 0) add('jcos:terms', 'JCOS 案件の金額にマイナスの値があります。');
    const sync = p.reportSync;
    if (sync) {
      const stale = syncStaleness(p, data);
      if (stale.venue) add('report:stale', '日報の同期のあとで会場が変わっています（同期した実績は使っていません）。もう一度「日報を同期」を押してください。');
      else if (stale.names) add('report:stale', '日報の同期のあとで、会場名または別名が変わっています（変わった名前で取り込んだ日の実績は使っていません）。もう一度「日報を同期」を押してください。');
      else if (stale.period) add('report:stale', '日報の同期のあとで会期が変わっています。もう一度「日報を同期」を押してください。');
      if (sync.held?.length) add('report:held', `日報: 同じ会場で会期が重なる別の案件があるため、取り込みを保留している日が ${sync.held.length} 日あります（どちらの案件の実績か、確認が必要です）。`);
      // 同期したあとで、会期が重なる案件が増えた・決定が変わった日（同じ回答を 2 つの案件で数えないよう、使っていない）
      const contested = contestedReportDays(p, data);
      const undecided = contested.filter((h) => h.state === 'held');
      const assigned = contested.filter((h) => h.state === 'theirs');
      if (undecided.length) add('report:contested', `日報: 同期済みの実績のうち ${undecided.length} 日は、同じ会場で会期が重なる別の案件があるため、使っていません（${undecided.map((h) => shortDate(h.date)).join('・')}）。どちらの案件の実績か、確認が必要です。`);
      if (assigned.length) add('report:assigned', `日報: 同期済みの実績のうち ${assigned.length} 日は、別の案件の実績として割り当て済みのため、使っていません（${assigned.map((h) => shortDate(h.date)).join('・')}）。`, 'info');
      const unread = (sync.skipped ?? []).filter((x) => x.reason !== 'other-project').reduce((n, x) => n + x.rows, 0);
      if (unread > 0) add('report:skipped', `日報: 読み取れずに実績へ入れていない回答が ${unread} 件あります（「日報を同期」の詳細を確認してください）。`);
      const gaps = unmatchedGaps(sync);
      if (gaps.length) add('report:unmatched', `日報: この案件の実績が無い日に、別の会場名の回答があります（${gaps.map((u) => `「${u.venue}」`).join('')}）。この会場の別の書き方なら、別名として登録してください。`, 'info');
    }
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
  // 図面上に名前が出ないパーツ（椅子など）は、パーツ名で示す
  const nameOf = (it: PlacedItem) =>
    (labels.get(it.id) || data.partTypes.find((t) => t.id === it.partTypeId)?.name || 'パーツ').replace(/\n/g, ' ');
  const ov = findOverlaps(p.layout, data.partTypes);
  if (ov.length > 0) {
    const names = ov.slice(0, 3).map(([a, b]) => `${nameOf(a)}×${nameOf(b)}`).join('、');
    add('layout:overlap', `パーツが重なっています（${ov.length}組: ${names}${ov.length > 3 ? ' ほか' : ''}）。`);
  }
  // 図面の外にあるパーツ（少しでもはみ出していれば対象。自動では動かさない。作業ログ D-20）
  // 図面サイズを小さくした・パーツの寸法を大きくした・小さい雛形に置き換えた、などで起きる
  // 端にぴったり寄せたパーツが、小数の計算誤差（1100.3 ＋ 29.7 ＝ 1130.0000000000002 など）で「外」と判定されないよう、ごくわずかな幅を許す
  const EPS = 1e-6;
  const outside = p.layout.items.filter((it) => {
    const s = itemSize(it, data.partTypes.find((t) => t.id === it.partTypeId));
    return it.x < -EPS || it.y < -EPS || it.x + s.w > p.layout.width + EPS || it.y + s.h > p.layout.height + EPS;
  });
  if (outside.length > 0) {
    const names = outside.slice(0, 3).map(nameOf).join('、');
    add('layout:outside', `図面の外にパーツがあります（${outside.length}個: ${names}${outside.length > 3 ? ' ほか' : ''}）。図面サイズを広げるか、パーツを図面の中に動かしてください。`);
  }
  if (p.layout.env.length === 0) add('layout:env', '会場の雛形（周辺環境）が未設定です。', 'info');

  // ── 制作席の過不足（上限回転数が入力されているときだけ。作業ログ D-16） ──
  // 必要量（席・日）＝ Σ 予定個数 ÷ 上限回転数。制作席 × 日数 を超えたら警告（ちょうどなら警告しない）
  const need = seatDemand(p);
  if (need != null && need > 0 && dates.length > 0) {
    const seats = countSeats(p.layout, data.partTypes).work;
    const capacity = seats * dates.length;
    const f = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1));
    // 表示する必要量は小数第 1 位に切り上げる（80.05 を「80.0」と出すと、足りているように読めるため）
    const shown = Math.ceil(need * 10 - 1e-9) / 10;
    if (seats === 0) {
      add('layout:seats', 'レイアウトに制作席（椅子）がありません。上限回転数が入力されているコンテンツがあります。');
    } else if (need > capacity + 1e-9) {
      add('layout:seats', `制作席が足りない計算です：必要 ${f(shown)} 席・日（Σ 予定個数 ÷ 上限回転数）に対し、制作席 ${seats} 席 × ${dates.length} 日 ＝ ${capacity} 席・日。席を増やす・日数を延ばす・予定個数か上限回転数を見直す、のいずれかが必要です。`);
    }
  }

  return w;
}

/** target の前方一致で警告を引く（セルの色付け用） */
export function warningsFor(ws: Warning[], target: string): Warning[] {
  return ws.filter((x) => x.target === target);
}
