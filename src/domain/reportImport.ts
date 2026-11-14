// 日報から、案件の候補を作る（純関数）。案件一覧の「日報から案件を作成・更新」が使う。
// 通信はここでは行わない。設計は docs/02_新アプリ設計書.md「7. Version 5」。
//
// 考え方:
//   - 案件の単位は「会場 × 連続した開催日のまとまり」。同じ会場でも、開催日が連続していなければ、別の開催として分ける
//     （同じ会場で、別の期間に開催した案件を、1 つにまとめない）。数日しか離れていないまとまりは、利用者が選んだときだけ、
//     同じ案件にまとめる（間の日は「開催していない日」として扱う。すべての日を開催した日として扱わない）。
//   - 既存の案件との対応づけは「会場＋会期」（イベント名は使わない）。会場名が合い、会期に開催日を 1 日でも含む、進行中の案件。
//       0 件 … 新しい案件の候補 ／ 1 件 … その案件の更新 ／ 2 件以上 … 決められないので、どちらにも入れずに確認を求める
//   - 会場は、日報の会場名で会場マスタを引く。全角/半角・空白・英字の大小だけをそろえて同じなら、登録済みの会場を使う
//     （会場名でも、登録した別名でも同じ。同じ会場の書き方が日によって違っても、1 つの開催として扱う）。
//     無ければ、新しい会場として登録する（名前が似ているだけでは、まとめない）。記号・括弧だけが違う会場があるとき
//     （登録済みの会場・同じ日報の中の別の書き方）だけ、「同じ会場（別名として登録）／別の会場」を利用者に確認する。
//     「同じ会場」は、その場で会場マスタに反映する（withSameVenue）。以後は、登録済みの会場として扱われる。
//   - 実績の作り方（照合・集計・読み取れない回答があれば止める）は、案件の「日報を同期」と同じ関数（report.ts）を使う。
import { Project, ReportSource, ReportSync, Venue } from '../types';
import { defaultJcos, markNotHeld } from './jcos';
import {
  FIRST_ANSWER_ROW, NEAR_GAP_DAYS, RawReportRow, ReportIssue, dateProblem, fittedPeriod, hasAutoPeriod, isBlankRow, isCancelled, isTestRow, parseReportDate, periodLabel,
  planProjectSync, planReportSync, reportVenue, text, venueKey, venueKeys, venueProblem, widenTarget,
} from './report';
import { newProject, newVenue } from './seed';
import { MAX_DAYS, dateOfDay, dayNumber, genId, listDates } from './util';

// ── 開催日のまとまり ──────────────────────────────────────────
/** 会場 × 連続した開催日のまとまり（日報だけで決まる。同じ日報なら、いつ読んでも同じ id になる） */
export interface ReportRun {
  /**
   * まとまりの id。回答に出てくる会場名（照合用にそろえた形。複数あれば、並べて最初のもの）＋ 最初の開催日。
   * 会場マスタへの登録の有無では変わらない（候補を 1 件だけ作って会場が登録されても、残りの候補の id は同じ）。
   */
  id: string;
  /**
   * 会場を見分けるキー。登録済みの会場（会場名か別名が、日報の会場名と同じ）なら、その会場ごと（書き方が違っても、同じまとまり）。
   * 未登録なら、日報の会場名（照合用にそろえた形）。
   */
  key: string;
  /** 登録済みの会場の ID（未登録なら null） */
  venueId: string | null;
  /** このまとまりの回答に出てくる会場名（照合用にそろえた形）。案件との対応づけに使う */
  keys: string[];
  /** 日報に書かれていた会場名（同じ会場で書き方が複数あれば、いちばん多い書き方） */
  venueName: string;
  /** 回答のある日（日付順・重複なし・連続している） */
  dates: string[];
  startDate: string;
  endDate: string;
  /** 回答の数 */
  rows: number;
  /** 日報のイベント名（いちばん多いもの。無ければ ''）。照合には使わない（案件名の初期値にだけ使う） */
  eventName: string;
  /** 同じ会場の、直前のまとまり。回答の無い日が NEAR_GAP_DAYS 日以内のときだけ（同じ案件にまとめる候補） */
  prev: { id: string; gap: number } | null;
}

/** いちばん多い値（同数なら、先に出てきたもの）。無ければ '' */
function mostCommon(counts: Map<string, number>): string {
  let best = '';
  let n = 0;
  for (const [k, c] of counts) if (c > n) { best = k; n = c; }
  return best;
}

export interface RunsResult {
  runs: ReportRun[];
  /** 日報から読んだ回答の数（空行を除く） */
  rowsRead: number;
  /** テスト回答の数 */
  tests: number;
  /** どの開催のものか決められない回答（開催日か会場名を読み取れない） */
  loose: ReportIssue[];
}

/** 登録済みの会場のまとまりのキー（会場名のキーは空白を含まないので、未登録の会場のキーと重ならない） */
const registeredKey = (venueId: string): string => `venue ${venueId}`;

/**
 * 日報の回答を、会場 × 連続した開催日のまとまりに分ける。テスト回答・空行は除く。
 * venues を渡すと、登録済みの会場は、会場名でも別名でも同じ会場としてまとめる（同じ名前の会場が複数あれば、先に登録されているもの）。
 */
export function reportRuns(rows: RawReportRow[], venues: Venue[] = []): RunsResult {
  const byKey = new Map<string, { venueId: string | null; names: Map<string, number>; days: Map<string, { rows: number; events: string[]; keys: Set<string> }> }>();
  const registered = new Map<string, Venue | null>();
  const venueOf = (key: string): Venue | null => {
    if (!registered.has(key)) registered.set(key, venues.find((v) => venueKeys(v).has(key)) ?? null);
    return registered.get(key) ?? null;
  };
  const loose: ReportIssue[] = [];
  let rowsRead = 0;
  let tests = 0;
  rows.forEach((r, index) => {
    if (isBlankRow(r)) return;
    rowsRead += 1;
    if (isTestRow(r)) { tests += 1; return; }
    const v = reportVenue(r);
    const date = parseReportDate(r.date);
    if (!v || !date) {
      const items: ReportIssue['items'] = [];
      const badDate = dateProblem(r.date);
      if (badDate) items.push({ field: '開催日', reason: badDate });
      const badVenue = venueProblem(r);
      if (badVenue) items.push(badVenue);
      loose.push({ row: index + FIRST_ANSWER_ROW, date, items });
      return;
    }
    const reg = venueOf(v.key);
    const groupKey = reg ? registeredKey(reg.id) : v.key;
    const k = byKey.get(groupKey) ?? { venueId: reg?.id ?? null, names: new Map<string, number>(), days: new Map<string, { rows: number; events: string[]; keys: Set<string> }>() };
    k.names.set(v.name, (k.names.get(v.name) ?? 0) + 1);
    const d = k.days.get(date) ?? { rows: 0, events: [], keys: new Set<string>() };
    d.rows += 1;
    d.keys.add(v.key);
    const event = text(r.event);
    if (event) d.events.push(event);
    k.days.set(date, d);
    byKey.set(groupKey, k);
  });

  const runs: ReportRun[] = [];
  for (const [key, k] of byKey) {
    const venueName = mostCommon(k.names);
    const dates = [...k.days.keys()].sort();
    let cur: string[] = [];
    let last: ReportRun | null = null;
    const close = () => {
      if (cur.length === 0) return;
      const events = new Map<string, number>();
      const keys = new Set<string>();
      let n = 0;
      for (const d of cur) {
        const day = k.days.get(d)!;
        n += day.rows;
        for (const e of day.events) events.set(e, (events.get(e) ?? 0) + 1);
        for (const x of day.keys) keys.add(x);
      }
      const names = [...keys].sort();
      const gap: number = last ? dayNumber(cur[0]) - dayNumber(last.endDate) - 1 : Infinity;
      const run: ReportRun = {
        id: `${names[0]}@${cur[0]}`, key, venueId: k.venueId, keys: names, venueName, dates: cur, startDate: cur[0], endDate: cur[cur.length - 1], rows: n,
        eventName: mostCommon(events), prev: last && gap <= NEAR_GAP_DAYS ? { id: last.id, gap } : null,
      };
      runs.push(run);
      last = run;
      cur = [];
    };
    for (const d of dates) {
      if (cur.length > 0 && dayNumber(d) - dayNumber(cur[cur.length - 1]) > 1) close();
      cur.push(d);
    }
    close();
  }
  runs.sort((a, b) => a.startDate.localeCompare(b.startDate) || a.venueName.localeCompare(b.venueName));
  return { runs, rowsRead, tests, loose };
}

/** 案件 1 件分の開催（まとまり 1 つ。利用者が「同じ案件にする」を選んだときは、複数のまとまり） */
export interface ImportGroup {
  /** 最初のまとまりの id */
  id: string;
  key: string;
  venueId: string | null;
  keys: string[];
  venueName: string;
  /** joined … 利用者が「前の開催と同じ案件にする」を選んで、まとめた開催 */
  runs: { id: string; startDate: string; endDate: string; joined?: boolean }[];
  /** 回答のある日 */
  dates: string[];
  startDate: string;
  endDate: string;
  /** 開始日〜終了日のうち、回答の無い日（開催していない日として扱う） */
  gaps: string[];
  rows: number;
  eventName: string;
  /** まだまとめていない、直前の開催（「同じ案件にする」を選べる） */
  joinPrev: { runId: string; prevId: string; gap: number } | null;
}

/** まとまりを、案件の単位にする。joins に入っているまとまりは、直前のまとまりと同じ案件にする */
export function groupRuns(runs: ReportRun[], joins: ReadonlySet<string>): ImportGroup[] {
  const groups: ImportGroup[] = [];
  const of = new Map<string, ImportGroup>();          // まとまりの id → 入っている案件の単位
  // 同じ会場のまとまりを、日付順に見る（直前のまとまりが、先に案件の単位に入っているように）
  for (const run of [...runs].sort((a, b) => a.startDate.localeCompare(b.startDate))) {
    const target = run.prev && joins.has(run.id) ? of.get(run.prev.id) : undefined;
    if (target) {
      target.runs.push({ id: run.id, startDate: run.startDate, endDate: run.endDate, joined: true });
      target.keys = [...new Set([...target.keys, ...run.keys])].sort();
      target.dates = [...target.dates, ...run.dates].sort();
      target.endDate = run.endDate;
      target.rows += run.rows;
      if (!target.eventName) target.eventName = run.eventName;
      of.set(run.id, target);
      continue;
    }
    const g: ImportGroup = {
      id: run.id, key: run.key, venueId: run.venueId, keys: run.keys, venueName: run.venueName, runs: [{ id: run.id, startDate: run.startDate, endDate: run.endDate }],
      dates: [...run.dates], startDate: run.startDate, endDate: run.endDate, gaps: [], rows: run.rows, eventName: run.eventName,
      joinPrev: run.prev ? { runId: run.id, prevId: run.prev.id, gap: run.prev.gap } : null,
    };
    groups.push(g);
    of.set(run.id, g);
  }
  for (const g of groups) {
    const have = new Set(g.dates);
    g.gaps = listDates(g.startDate, g.endDate).filter((d) => !have.has(d));
  }
  return groups.sort((a, b) => a.startDate.localeCompare(b.startDate) || a.venueName.localeCompare(b.venueName));
}

// ── 会場マスタとの照合 ─────────────────────────────────────────
/** 記号・括弧・区切りを除いた会場名（「記号だけが違う」会場を見つけるため。照合そのものには使わない） */
export function looseVenueKey(s: unknown): string {
  return venueKey(s).replace(/[\p{P}\p{S}]/gu, '');
}

export type VenueMatch =
  /** 登録済みの会場（会場名か別名が、日報の会場名と同じ）。others … 同じ名前で登録されている、ほかの会場の数 */
  | { state: 'known'; venue: Venue; others: number }
  /** 登録が無い … 新しい会場として登録する */
  | { state: 'new' }
  /**
   * 登録は無いが、記号・括弧だけが違う会場がある … 同じ会場か、別の会場かを、利用者に確かめる。
   *   candidates … 登録済みの会場 ／ pending … 同じ日報の中の、まだ登録していない別の書き方（この取り込みで、新しく登録するもの）
   *   choiceNew … 「別の会場（新しく登録）」を選んだことを覚えるための値（ImportInput.venueChoice に入れる）。
   *               比べた相手の一覧を含むので、相手が増えたら（別の書き方も「別の会場」と決まった、など）、もう一度確かめることになる
   */
  | { state: 'similar'; candidates: Venue[]; pending: { key: string; name: string }[]; choiceNew: string };

/** 日報の会場名（照合用にそろえた形）で、会場マスタを引く */
export function matchVenue(key: string, venues: Venue[]): VenueMatch {
  const exact = venues.filter((v) => venueKeys(v).has(key));
  if (exact.length > 0) return { state: 'known', venue: exact[0], others: exact.length - 1 };
  const loose = looseVenueKey(key);
  const similar = loose ? venues.filter((v) => [v.name, ...(v.reportNames ?? [])].some((n) => looseVenueKey(n) === loose)) : [];
  return similar.length > 0 ? { state: 'similar', candidates: similar, pending: [], choiceNew: newVenueChoice(similar, []) } : { state: 'new' };
}

/** 「別の会場（新しく登録）」の選択を表す値。比べた相手（登録済みの会場の ID・未登録の書き方）の一覧つき */
function newVenueChoice(candidates: Venue[], pending: { key: string }[]): string {
  return `new:${[...candidates.map((v) => v.id), ...pending.map((x) => x.key)].sort().join('|')}`;
}

/**
 * 「同じ会場」と決めたときの、会場マスタ。
 *   target が登録済みの会場（venueId）… その会場に、日報での書き方（alias）を別名として足す
 *   target がまだ登録していない書き方（name）… その書き方を会場名にして新しく登録し、alias を別名にする（どちらの書き方でも、同じ会場になる）
 * すでに同じ会場になっているときは、何も変えない（同じ配列を返す）。
 */
export function withSameVenue(venues: Venue[], target: { venueId: string } | { name: string }, alias: string, newId: () => string = genId): Venue[] {
  const aliasKey = venueKey(alias);
  if (!aliasKey) return venues;
  const addTo = (id: string): Venue[] => venues.map((v) => (v.id === id && !venueKeys(v).has(aliasKey) ? { ...v, reportNames: [...(v.reportNames ?? []), alias.trim()] } : v));
  if ('venueId' in target) {
    const cur = venues.find((v) => v.id === target.venueId);
    return cur && !venueKeys(cur).has(aliasKey) ? addTo(cur.id) : venues;
  }
  const key = venueKey(target.name);
  if (!key) return venues;
  const exists = venues.find((v) => venueKeys(v).has(key));
  if (exists) return venueKeys(exists).has(aliasKey) ? venues : addTo(exists.id);
  const name = target.name.trim();
  return [...venues, { ...newVenue(), id: newId(), name, reportNames: [...new Set([name, alias.trim()])] }];
}

// ── 候補 ─────────────────────────────────────────────────────
/** 実績の合計（日報の実績がある日の分） */
export interface ImportTotals {
  days: number;
  count: number;
  /** 参加組数・参加人数の合計（入力のあった分。1 件も無ければ null）と、未入力のある日数 */
  groups: number | null;
  groupsMissing: number;
  people: number | null;
  peopleMissing: number;
}

export function totalsOf(sync: ReportSync): ImportTotals {
  const days = sync.days;
  const sumOf = (pick: (d: ReportSync['days'][number]) => number | undefined): number | null => {
    const have = days.filter((d) => pick(d) !== undefined);
    return have.length > 0 ? have.reduce((s, d) => s + (pick(d) ?? 0), 0) : null;
  };
  return {
    days: days.length,
    count: days.reduce((s, d) => s + d.count, 0),
    groups: sumOf((d) => d.groups),
    groupsMissing: days.filter((d) => d.groups === undefined || (d.groupsBlank ?? 0) > 0).length,
    people: sumOf((d) => d.people),
    peopleMissing: days.filter((d) => d.people === undefined || (d.peopleBlank ?? 0) > 0).length,
  };
}

interface ItemBase {
  /** 案件の単位の id（最初のまとまりの id） */
  id: string;
  /** 会場を見分けるキー（ReportRun.key） */
  key: string;
  /** 会場名（登録済みの会場なら、会場マスタの会場名。未登録なら、日報での書き方） */
  venueName: string;
  runs: ImportGroup['runs'];
  dates: string[];
  startDate: string;
  endDate: string;
  gaps: string[];
  rows: number;
  /** まだまとめていない、直前の開催（「同じ案件にする」を選べる）。新しい候補どうしのときだけ（既存の案件につなぐときは、CreateItem.near） */
  joinPrev: ImportGroup['joinPrev'];
}

/** 新しい候補のすぐ近くに会期がある、既存の案件（同じ開催なら、この案件の会期を広げて取り込める） */
export interface NearProject {
  projectId: string;
  projectName: string;
  /** いまの会期 */
  startDate: string;
  endDate: string;
  /** この開催の日をすべて取り込むための、広げたあとの会期 */
  widenTo: { startDate: string; endDate: string };
}

/** 新しい案件の候補 */
export interface CreateItem extends ItemBase {
  kind: 'create';
  /** 案件名の初期値（日報のイベント名。無い・ほかと重なるときは、開催日を添える） */
  name: string;
  venue: VenueMatch;
  /** 使う会場（決まっているとき）。isNew … 会場マスタに新しく登録する */
  venuePlan: { use: Venue; isNew: boolean } | null;
  /** 作成できない理由（作成できるなら null） */
  blocked:
    | null
    | { reason: 'venue' }                                                     // 会場の確認待ち（記号だけが違う会場がある）
    | { reason: 'rows'; message: string; issues: ReportIssue[] }              // 読み取れない回答がある
    | { reason: 'setup'; message: string };
  /** 作成する案件（実績つき）。blocked のときは null。実績は、作成するときに作り直す（importCreates） */
  project: Project | null;
  totals: ImportTotals | null;
  /** 会期が重なる、中止の案件の名前（あれば、作成の前に確かめてもらう） */
  cancelled: string[];
  /**
   * 会期が、この開催のすぐ近く（回答の無い日が NEAR_GAP_DAYS 日以内）にある、同じ会場の進行中の案件。
   * 同じ開催（予定より早く始まった・延びた）かもしれないので、既定では作成の対象にしない（利用者が選ぶ）。
   */
  near: NearProject[];
}

/** 既存の案件の更新（案件の「日報を同期」と同じ処理）。案件 1 件につき 1 つ（会期に、開催が 2 つ以上入っていても、まとめる） */
export interface UpdateItem extends ItemBase {
  kind: 'update';
  projectId: string;
  projectName: string;
  /** この案件の開催の日のうち、会期（日報に合わせた分を含む）の外にあって、会期を広げれば取り込める日 */
  outside: string[];
  /** outside を取り込むための、広げたあとの会期（outside が無ければ null）。ほかの進行中の案件の会期は越えない */
  widenTo: { startDate: string; endDate: string } | null;
  /** 同期の見込み。changed … いま保存してある実績・会期と違う（＝同期すると、案件が変わる） */
  preview:
    | { ok: true; totals: ImportTotals; changed: boolean; period: { startDate: string; endDate: string } | null }
    | { ok: false; message: string; issues: ReportIssue[] };
}

/** 対応する案件が 2 件以上あって、決められない日（dates は、その日だけ） */
export interface AmbiguousItem extends ItemBase {
  kind: 'ambiguous';
  projects: { id: string; name: string }[];
}

export type ImportItem = CreateItem | UpdateItem | AmbiguousItem;

export interface ImportPlan {
  rowsRead: number;
  tests: number;
  /** どの開催のものか決められない回答（開催日か会場名を読み取れない）。関係する候補・案件の同期は、止まる */
  loose: ReportIssue[];
  /** 新しい案件の候補・既存の案件の更新・決められない開催（それぞれ、開催日の順） */
  items: ImportItem[];
  /**
   * いまの案件の一覧に、日報から決めた会期の案件の「この取得で合わせたあとの会期」を入れたもの（見込み）。
   * 既存の案件の更新は、ほかの案件を、この見込みの会期で見て計画する（同じ回の更新で、隣の案件の会期が伸びる日を、
   * 「会期のすぐ外の回答」として記録しないため）。書くときも、同じ一覧を使う（見込みと、書く内容を、食い違わせない）。
   */
  projected: Project[];
  /** 日報にある開催日の範囲（テスト回答を除く）。回答が無ければ null */
  span: { startDate: string; endDate: string } | null;
}

export interface ImportInput {
  rows: RawReportRow[];
  projects: Project[];
  venues: Venue[];
  source: ReportSource;
  /** 同期した日時（ISO 8601） */
  now: string;
  /** 「前の開催と同じ案件にする」と利用者が選んだ、開催日のまとまり（ReportRun.id） */
  joins?: ReadonlySet<string>;
  /**
   * 記号だけが違う会場があるときに、利用者が「別の会場（新しく登録）」を選んだ会場
   * （会場を見分けるキー → そのときの VenueMatch.choiceNew）。比べた相手が変わっていたら、選んでいない扱いになる。
   */
  venueChoice?: Readonly<Record<string, string>>;
  /** 新しい案件・会場の ID を作る（テストで差し替える） */
  newId?: () => string;
}

/**
 * 案件名の初期値。日報のイベント名があればそれ。無ければ「会場名（開催日）」。
 * 照合には使わない（同じイベント名の開催が複数あっても、会場と開催日で見分ける）。
 */
export function importName(g: Pick<ImportGroup, 'eventName' | 'venueName' | 'startDate' | 'endDate'>): string {
  return g.eventName || `${g.venueName}（${periodLabel(g.startDate, g.endDate)}）`;
}

/**
 * 候補の案件名を決める。同じ名前が、候補どうし・いまの案件と重なるときは、開催日を添える（それでも重なるときは、会場名も添える。
 * いまの案件とまったく同じ名前になるとき——別の年の、同じ会場・同じ日付の開催——は、年も添える）。
 * 一覧で見分けられるようにするため（同じイベント名で、別の期間・別の会場に開催した案件が、同じ名前で並ばないように）。
 */
export function importNames(cands: Pick<ImportGroup, 'eventName' | 'venueName' | 'startDate' | 'endDate'>[], taken: ReadonlySet<string>): string[] {
  const countOf = (names: string[]): Map<string, number> => {
    const m = new Map<string, number>();
    for (const n of names) m.set(n, (m.get(n) ?? 0) + 1);
    return m;
  };
  const label = (c: (typeof cands)[number]): string => periodLabel(c.startDate, c.endDate);
  // いまの案件が、その名前か、その名前に（開催日など）を添えた名前を使っているか（先に作った案件と、付け方をそろえる）
  const names = [...taken];
  const used = (n: string): boolean => taken.has(n) || names.some((t) => t.startsWith(`${n}（`));
  const first = cands.map(importName);
  const n1 = countOf(first);
  const second = cands.map((c, i) => (c.eventName && ((n1.get(first[i]) ?? 0) > 1 || used(first[i])) ? `${c.eventName}（${label(c)}）` : first[i]));
  const n2 = countOf(second);
  const third = cands.map((c, i) => (c.eventName && (n2.get(second[i]) ?? 0) > 1 ? `${c.eventName}（${c.venueName}・${label(c)}）` : second[i]));
  return cands.map((c, i) => {
    if (!taken.has(third[i])) return third[i];
    const tail = `${label(c)}）`;
    return third[i].endsWith(tail) ? `${third[i].slice(0, -tail.length)}${c.startDate.slice(0, 4)}/${tail}` : third[i];
  });
}

/** 並び順に左右されない形にする（オブジェクトのキーを並べ直す。配列の順はそのまま） */
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return Object.fromEntries(Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => [k, canonical(o[k])]));
  }
  return v;
}

/**
 * 同期の結果のうち、案件の中身として意味のある部分（同期した日時・読んだ回答の数は除く）。同じなら、同期しても案件は変わらない。
 * キーの並び順は見ない（同期で作った結果と、保存して読み直した結果とで、項目の並びが違うことがある）。
 */
function syncShape(s: ReportSync | undefined): string {
  if (!s) return '';
  return JSON.stringify(canonical([s.venueId, s.startDate, s.endDate, s.days, s.rowsUsed, s.skipped, s.held, s.unmatched, s.contents ?? [], s.outside ?? []]));
}

const minDate = (a: string, b: string): string => (a <= b ? a : b);
const byStart = <T extends { startDate: string; venueName: string }>(a: T, b: T): number => a.startDate.localeCompare(b.startDate) || a.venueName.localeCompare(b.venueName);
const nameOf = (p: Pick<Project, 'name'>): string => p.name || '（名称未設定）';

const CANNOT_CREATE = (n: number): string =>
  `日報に、読み取れない回答が ${n} 件あるため、この開催の案件は作成できません。下の回答を日報で直してから、もう一度「日報から案件を作成・更新」を押してください。`;

/**
 * 日報の回答と、いまの案件・会場から、「新しく作る案件」「更新する案件」「確認が要るもの」を決める。何も書き換えない。
 * 同じ入力なら、同じ結果になる（newId を除く）。利用者の選択（joins・venueChoice）や、案件・会場が変わったら、呼び直す。
 *
 * 開催日 1 日ごとに、どの案件のものかを決める（案件の「日報を同期」と同じ見方）:
 *   その日を会期（日報に合わせた分を含む）に含む、同じ会場の進行中の案件が
 *     1 件 … その案件の実績（更新）
 *     2 件以上 … 「この案件の実績にする」と決めている案件が 1 件だけなら、その案件。そうでなければ、決められない
 *     0 件 … 同じ開催（連続した開催日）の中に、案件のある日があれば、その案件の「会期の外の回答」。無ければ、新しい案件の候補
 */
export function planReportImport(input: ImportInput): ImportPlan {
  const { rows, projects, venues, source, now } = input;
  const newId = input.newId ?? genId;
  const ctx = { projects, venues };
  const { runs, rowsRead, tests, loose } = reportRuns(rows, venues);
  const venueById = new Map(venues.map((v) => [v.id, v]));
  const projectKeys = new Map(projects.map((p) => [p.id, venueKeys(venueById.get(p.venueId))]));
  const active = projects.filter((p) => !isCancelled(p));
  const cancelledProjects = projects.filter(isCancelled);
  /** 回答に出てくる会場名のどれかを、会場名・別名に持つ案件 */
  const related = (keys: string[], list: Project[] = active): Project[] => list.filter((p) => keys.some((k) => projectKeys.get(p.id)?.has(k)));

  // 「前の開催と同じ案件にする」は、間の日に、ほかの進行中の案件（同じ会場）の会期が入っているときは、使わない
  // （まとめると、その案件と会期が重なる）
  const runById = new Map(runs.map((r) => [r.id, r]));
  const gapTaken = (run: ReportRun): boolean => {
    const prev = run.prev ? runById.get(run.prev.id) : undefined;
    if (!prev) return false;
    const gap = new Set(listDates(nextDay(prev.endDate), nextDay(run.startDate, -1)));
    return gap.size > 0 && related([...new Set([...prev.keys, ...run.keys])]).some((p) => listDates(p.startDate, p.endDate).some((d) => gap.has(d)));
  };
  const joins = new Set([...(input.joins ?? [])].filter((id) => { const r = runById.get(id); return !!r && !gapTaken(r); }));
  const groups = groupRuns(runs, joins);

  // 日報から決めた会期の案件が、この取得で会期を合わせたあとの一覧（見込み）。ほかの案件の計画は、この会期と照らす
  const projected = projects.map((p) => {
    const f = !isCancelled(p) && hasAutoPeriod(p) ? fittedPeriod(p, rows, ctx) : null;
    return f ? { ...p, startDate: f.startDate, endDate: f.endDate } : p;
  });
  /** その案件から見た、ほかの案件（見込みの会期）。その案件自身は、いまの内容のまま */
  const around = (p: Project): Project[] => projected.map((q) => (q.id === p.id ? p : q));
  // 案件ごとの、指定なしの同期の計画（日報から決めた会期の案件は、会期を日報に合わせる）と、そのあとの会期
  const autoPlans = new Map<string, ReturnType<typeof planProjectSync>>();
  const autoOf = (p: Project): ReturnType<typeof planProjectSync> => {
    let a = autoPlans.get(p.id);
    if (!a) { a = planProjectSync({ project: p, projects: around(p), venues, rows, now }); autoPlans.set(p.id, a); }
    return a;
  };
  const afterOf = (p: Project): { startDate: string; endDate: string } => autoOf(p).change?.to ?? { startDate: p.startDate, endDate: p.endDate };

  // ── 開催日 1 日ごとに、どの案件のものかを決める ──
  interface Bucket { p: Project; groups: ImportGroup[]; owned: Set<string>; free: Set<string> }
  const buckets = new Map<string, Bucket>();
  const creates: { g: ImportGroup; rel: Project[]; cancelled: string[] }[] = [];
  const ambiguous: AmbiguousItem[] = [];
  const venueNameOf = (g: ImportGroup): string => (g.venueId && venueById.get(g.venueId)?.name) || g.venueName;
  for (const g of groups) {
    const rel = related(g.keys);
    const periods = rel.map((p) => { const a = afterOf(p); return { p, days: new Set(listDates(a.startDate, a.endDate)) }; });
    const owned = new Map<string, string[]>();
    const multi: string[] = [];
    const multiOwners = new Map<string, Project>();
    const free: string[] = [];
    for (const d of g.dates) {
      let owners = periods.filter((x) => x.days.has(d)).map((x) => x.p);
      if (owners.length >= 2) {
        const claimers = owners.filter((p) => (p.reportClaims ?? []).includes(d));
        if (claimers.length === 1) owners = claimers;
      }
      if (owners.length === 1) owned.set(owners[0].id, [...(owned.get(owners[0].id) ?? []), d]);
      else if (owners.length >= 2) { multi.push(d); for (const p of owners) multiOwners.set(p.id, p); }
      else free.push(d);
    }
    if (owned.size === 0 && multi.length === 0) {
      const held = new Set(g.dates);
      const cancelled = related(g.keys, cancelledProjects).filter((p) => listDates(p.startDate, p.endDate).some((d) => held.has(d))).map(nameOf);
      creates.push({ g, rel, cancelled });
      continue;
    }
    for (const [id, ds] of owned) {
      const b = buckets.get(id) ?? { p: rel.find((p) => p.id === id)!, groups: [], owned: new Set<string>(), free: new Set<string>() };
      b.groups.push(g);
      for (const d of ds) b.owned.add(d);
      for (const d of free) b.free.add(d);
      buckets.set(id, b);
    }
    if (multi.length > 0) {
      // 決められない日だけを示す（同じ開催の、案件が決まる日は、その案件の更新に入れる）。案件が決まる日が 1 日も無ければ、残りの日も一緒に示す
      const ds = owned.size === 0 ? [...multi, ...free].sort() : multi;
      ambiguous.push({
        id: g.id, key: g.key, venueName: venueNameOf(g), runs: g.runs, dates: ds, startDate: ds[0], endDate: ds[ds.length - 1], gaps: [], rows: g.rows, joinPrev: null,
        kind: 'ambiguous', projects: [...multiOwners.values()].map((p) => ({ id: p.id, name: nameOf(p) })),
      });
    }
  }

  // ── 既存の案件の更新（案件 1 件につき 1 つ） ──
  const updates: UpdateItem[] = [];
  for (const b of buckets.values()) {
    const { p } = b;
    const auto = autoOf(p);
    const after = afterOf(p);
    const inPeriod = new Set(listDates(after.startDate, after.endDate));
    // 同じ開催の中で、どの案件の会期にも入っていない日。会期を広げて届く範囲（ほかの進行中の案件の会期まで）のものだけ、この案件の「会期の外の回答」にする
    const free = [...b.free].filter((d) => !inPeriod.has(d)).sort();
    const reach = widenTarget(p, free, { projects: around(p), venues });
    const reachable = new Set(reach ? listDates(reach.startDate, reach.endDate) : []);
    const outside = free.filter((d) => reachable.has(d));
    const dates = [...new Set([...b.owned, ...outside])].sort();
    const have = new Set(dates);
    const first = b.groups[0];
    const preview: UpdateItem['preview'] = auto.plan.ok
      ? { ok: true, totals: totalsOf(auto.plan.sync), changed: !!auto.change || syncShape(auto.plan.sync) !== syncShape(p.reportSync), period: auto.change?.to ?? null }
      : { ok: false, message: auto.plan.message, issues: auto.plan.issues ?? [] };
    updates.push({
      id: first.id, key: first.key, venueName: venueById.get(p.venueId)?.name || first.venueName,
      runs: b.groups.flatMap((g) => g.runs), dates, startDate: dates[0], endDate: dates[dates.length - 1],
      gaps: listDates(dates[0], dates[dates.length - 1]).filter((d) => !have.has(d)),
      rows: b.groups.reduce((n, g) => n + g.rows, 0), joinPrev: null,
      kind: 'update', projectId: p.id, projectName: nameOf(p), outside, widenTo: outside.length > 0 ? reach : null, preview,
    });
  }

  // ── 新しい案件の候補 ──
  // 記号・空白だけが違う会場名（登録済みの会場・この日報の中の、未登録の別の書き方）があるときは、同じ会場かどうかを確かめる。
  // 同じ日報の中の書き方どうしは、回答の多い順に見る。先の書き方が「新しく登録する」と決まっていれば、あとの書き方は、それとも比べる
  // （「別の会場」と答えたあとで、比べる相手が増えたら、もう一度確かめる＝choiceNew が変わる）。
  const venueOfKey = new Map<string, { venue: VenueMatch; decided: boolean }>();
  {
    const classes = new Map<string, { key: string; name: string; rows: number; first: string }[]>();
    for (const { g } of creates) {
      const l = g.venueId ? '' : looseVenueKey(g.key);
      if (!l) continue;
      const list = classes.get(l) ?? [];
      const e = list.find((x) => x.key === g.key);
      if (e) { e.rows += g.rows; e.first = minDate(e.first, g.startDate); } else list.push({ key: g.key, name: g.venueName, rows: g.rows, first: g.startDate });
      classes.set(l, list);
    }
    for (const [l, list] of classes) {
      const registered = venues.filter((v) => [v.name, ...(v.reportNames ?? [])].some((n) => looseVenueKey(n) === l));
      const anchors: { key: string; name: string }[] = [];
      for (const m of [...list].sort((a, b) => b.rows - a.rows || a.first.localeCompare(b.first) || a.key.localeCompare(b.key))) {
        if (registered.length === 0 && anchors.length === 0) {
          venueOfKey.set(m.key, { venue: { state: 'new' }, decided: true });
          anchors.push({ key: m.key, name: m.name });
          continue;
        }
        const choiceNew = newVenueChoice(registered, anchors);
        const decided = input.venueChoice?.[m.key] === choiceNew;
        venueOfKey.set(m.key, { venue: { state: 'similar', candidates: registered, pending: [...anchors], choiceNew }, decided });
        if (decided) anchors.push({ key: m.key, name: m.name });
      }
    }
  }
  /** この取り込みで新しく登録する会場（同じ会場の候補が複数あっても、1 件にする） */
  const fresh = new Map<string, Venue>();
  const resolved = creates.map(({ g, rel, cancelled }) => {
    const known = g.venueId ? venueById.get(g.venueId) : undefined;
    let venue: VenueMatch;
    let venuePlan: CreateItem['venuePlan'] = null;
    if (known) {
      venue = { state: 'known', venue: known, others: venues.filter((v) => v.id !== known.id && g.keys.some((k) => venueKeys(v).has(k))).length };
      venuePlan = { use: known, isNew: false };
    } else {
      const r = venueOfKey.get(g.key) ?? { venue: { state: 'new' } as VenueMatch, decided: true };
      venue = r.venue;
      // 似た会場があるときは、利用者が「別の会場（新しく登録）」を選ぶまで、決めない（「同じ会場」は、会場マスタへの登録で決まる）
      if (r.decided) {
        // 日報での書き方を、会場名と別名の両方に持たせる（あとで会場名を変えても、日報との照合が切れない）
        const v = fresh.get(g.key) ?? { ...newVenue(), id: newId(), name: g.venueName, reportNames: [g.venueName] };
        fresh.set(g.key, v);
        venuePlan = { use: v, isNew: true };
      }
    }
    // すぐ近くに会期がある、同じ会場の進行中の案件（同じ開催かもしれない）。その案件の会期を広げれば、この開催の日がすべて入るものだけ
    const near: NearProject[] = rel.flatMap((q) => {
      const gap = g.startDate > q.endDate ? dayNumber(g.startDate) - dayNumber(q.endDate) - 1
        : g.endDate < q.startDate ? dayNumber(q.startDate) - dayNumber(g.endDate) - 1 : NaN;
      if (!(gap >= 0 && gap <= NEAR_GAP_DAYS)) return [];
      const to = widenTarget(q, g.dates, { projects: around(q), venues });
      const inside = new Set(to ? listDates(to.startDate, to.endDate) : []);
      return to && g.dates.every((d) => inside.has(d))
        ? [{ projectId: q.id, projectName: nameOf(q), startDate: q.startDate, endDate: q.endDate, widenTo: to }] : [];
    });
    return { g, cancelled, venue, venuePlan, near, venueName: known?.name || g.venueName };
  });
  const names = importNames(resolved.map((r) => ({ ...r.g, venueName: r.venueName })), new Set(projects.map((p) => p.name).filter(Boolean)));
  const createItems: CreateItem[] = resolved.map(({ g, cancelled, venue, venuePlan, near, venueName }, i) => {
    const base: ItemBase = {
      id: g.id, key: g.key, venueName, runs: g.runs, dates: g.dates, startDate: g.startDate, endDate: g.endDate, gaps: g.gaps, rows: g.rows, joinPrev: g.joinPrev,
    };
    const name = names[i];
    const none = { project: null, totals: null, cancelled, near };
    if (!venuePlan) return { ...base, kind: 'create', name, venue, venuePlan: null, blocked: { reason: 'venue' }, ...none };
    const span = dayNumber(g.endDate) - dayNumber(g.startDate) + 1;
    if (span > MAX_DAYS) {
      const message = `開催日が ${span} 日にわたって続いているため、1 件の案件にできません（1 件の案件は ${MAX_DAYS} 日まで）。「＋ 新しい案件」で、期間を分けて作ってください。`;
      return { ...base, kind: 'create', name, venue, venuePlan, blocked: { reason: 'setup', message }, ...none };
    }
    const use = venuePlan.use;
    const draft: Project = {
      ...newProject(use),
      id: newId(),
      name,
      startDate: g.startDate,
      endDate: g.endDate,
      status: '実施済',
      // 開始日〜終了日のうち、回答の無い日は、開催していない日（請求しない・アルバイト 0 人）
      jcos: markNotHeld(defaultJcos(), g.gaps),
      reportSource: source,
      reportPeriod: { startDate: g.startDate, endDate: g.endDate },
    };
    const plan = planReportSync({ project: draft, projects: [...projects, draft], venues: [...venues.filter((v) => v.id !== use.id), use], rows, now });
    if (!plan.ok) {
      const blocked: CreateItem['blocked'] = plan.issues?.length
        ? { reason: 'rows', message: CANNOT_CREATE(plan.issues.length), issues: plan.issues }
        : { reason: 'setup', message: plan.message };
      return { ...base, kind: 'create', name, venue, venuePlan, blocked, ...none };
    }
    return { ...base, kind: 'create', name, venue, venuePlan, blocked: null, project: { ...draft, reportSync: plan.sync }, totals: totalsOf(plan.sync), cancelled, near };
  });

  const items: ImportItem[] = [...createItems.sort(byStart), ...updates.sort(byStart), ...ambiguous.sort(byStart)];
  // 「前の開催と同じ案件にする」を出すのは、新しい候補どうしのときだけ（既存の案件につなぐときは、near の「会期を広げて取り込む」を使う。
  // 対応する案件を決められない開催・間の日に、ほかの案件の会期がある開催は、まとめない）
  const itemsOfRun = new Map<string, ImportItem[]>();
  for (const it of items) for (const r of it.runs) itemsOfRun.set(r.id, [...(itemsOfRun.get(r.id) ?? []), it]);
  for (const it of items) {
    const j = it.joinPrev;
    if (!j) continue;
    const run = runById.get(j.runId);
    const prevs = (itemsOfRun.get(j.prevId) ?? []).filter((x) => x !== it);
    const can = it.kind === 'create' && !!run && !gapTaken(run) && prevs.length > 0 && prevs.every((x) => x.kind === 'create');
    if (!can) it.joinPrev = null;
  }

  const all = runs.flatMap((r) => [r.startDate, r.endDate]).sort();
  return { rowsRead, tests, loose, items, projected, span: all.length > 0 ? { startDate: all[0], endDate: all[all.length - 1] } : null };
}

/**
 * 選んだ候補（新しい案件）を作るために、会場マスタと案件に足すもの。
 *   venues … 足したあとの会場マスタ（新しい会場を末尾に足す）
 *   projects … 新しく足す案件（実績つき）
 * 作成できない候補（blocked）と、選んでいない候補は、入れない。
 * 実績は、一緒に作る案件をすべて入れた状態で作り直す（会期のすぐ外にある回答が、一緒に作る別の案件のものかどうかで、
 * 「取り込んでいない回答」の内容が変わるため。作った直後に、案件が「日報と違う」と見えないようにする）。
 */
export function importCreates(
  plan: ImportPlan, ids: ReadonlySet<string>, ctx: { rows: RawReportRow[]; projects: Project[]; venues: Venue[]; now: string },
): { venues: Venue[]; projects: Project[]; addedVenues: Venue[] } {
  let next = ctx.venues;
  const addedVenues: Venue[] = [];
  const drafts: Project[] = [];
  for (const item of plan.items) {
    if (item.kind !== 'create' || !ids.has(item.id) || item.blocked || !item.project || !item.venuePlan) continue;
    const { use, isNew } = item.venuePlan;
    if (isNew && !next.some((v) => v.id === use.id)) {
      next = [...next, use];
      addedVenues.push(use);
    }
    drafts.push(item.project);
  }
  const all = [...ctx.projects, ...drafts];
  const out: Project[] = [];
  for (const d of drafts) {
    const r = planReportSync({ project: d, projects: all, venues: next, rows: ctx.rows, now: ctx.now });
    if (r.ok) out.push({ ...d, reportSync: r.sync });
  }
  return { venues: next, projects: out, addedVenues };
}

/** 日付の一覧を、連続する範囲にまとめる（表示用）。例: ['11-13','11-14','11-16'] → [['11-13','11-14'], ['11-16','11-16']] */
export function dateRanges(dates: string[]): [string, string][] {
  const out: [string, string][] = [];
  for (const d of [...dates].sort()) {
    const last = out[out.length - 1];
    if (last && dayNumber(d) - dayNumber(last[1]) === 1) last[1] = d;
    else if (!last || last[1] !== d) out.push([d, d]);
  }
  return out;
}

/** 日付の前後の日（表示・テスト用） */
export const nextDay = (d: string, n = 1): string => dateOfDay(dayNumber(d) + n);
