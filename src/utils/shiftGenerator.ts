import { Staff, WorkSite, ShiftAssignment } from '../types';
import { compareStaffNo } from './staffUtils';

// ── デフォルト値 ──────────────────────────────────────────────
const DEFAULT_MAX_CONSECUTIVE_DAYS = 5;
const DEFAULT_MAX_WORK_DAYS = 20;

// 曜日インデックス（getDay()）→ Staff.availableWeekdays の文字列
const DOW_KEYS = ['日', '月', '火', '水', '木', '金', '土'] as const;

// ── 日付ユーティリティ ────────────────────────────────────────
function parseDateLocal(s: string): Date {
  const [y, m, d] = s.replace(/\//g, '-').split('-').map(Number);
  return new Date(y, m - 1, d);
}

function formatDate(date: Date): string {
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// ── HARD CONSTRAINTS（絶対条件チェック関数群）────────────────
// 以下のいずれかを返す関数が false を返したスタッフはその現場に配置しない。

// 曜日制限：空配列・未定義は全曜日可能（既存データ互換）
function isAvailableOnDate(s: Staff, date: string): boolean {
  if (!s.availableWeekdays || s.availableWeekdays.length === 0) return true;
  const dow = DOW_KEYS[parseDateLocal(date).getDay()];
  return s.availableWeekdays.includes(dow);
}

// 月間最大勤務日数：上限未満なら通過
function isWithinMaxWorkDays(s: Staff, assignedDates: Set<string>): boolean {
  const limit = s.maxWorkDays ?? DEFAULT_MAX_WORK_DAYS;
  return assignedDates.size < limit;
}

// 最大連勤：追加後の連勤数が limit を超えるか
function wouldExceedConsecutive(
  assignedDates: Set<string>,
  targetDate: string,
  limit: number
): boolean {
  let count = 1;
  const back = parseDateLocal(targetDate);
  back.setDate(back.getDate() - 1);
  while (assignedDates.has(formatDate(back))) {
    count++;
    back.setDate(back.getDate() - 1);
  }
  const fwd = parseDateLocal(targetDate);
  fwd.setDate(fwd.getDate() + 1);
  while (assignedDates.has(formatDate(fwd))) {
    count++;
    fwd.setDate(fwd.getDate() + 1);
  }
  return count > limit;
}

/**
 * 絶対条件をすべて満たすか判定する。false を返したスタッフは配置しない。
 *
 * 将来の拡張:
 *   - 最低レベル要件: site.requiredLevel && (s.level ?? 1) < site.requiredLevel
 *   - リーダー必須現場: site.requiresLeader かつリーダー未配置なら非リーダーを除外
 */
function passesHardConstraints(
  s: Staff,
  site: WorkSite,
  assignedDates: Set<string>,
  alreadyAssignedIds: string[] = []
): boolean {
  // 1. 希望休
  if ((s.requestedDaysOff ?? []).includes(site.date)) return false;
  // 2. 勤務不可曜日
  if (!isAvailableOnDate(s, site.date)) return false;
  // 3. 月間最大勤務日数
  if (!isWithinMaxWorkDays(s, assignedDates)) return false;
  // 4. 最大連勤
  const consecutiveLimit = s.maxConsecutiveDays ?? DEFAULT_MAX_CONSECUTIVE_DAYS;
  if (wouldExceedConsecutive(assignedDates, site.date, consecutiveLimit)) return false;
  // 5. NGペア（双方向は UI 側で保証済み。片方向チェックで十分）
  if (s.ngPartnerIds?.some((id) => alreadyAssignedIds.includes(id))) return false;
  return true;
}

// ── SOFT SCORES（スコアリング関数）───────────────────────────

/** scoreStaffForSite が返すスコア内訳。高いほど優先度が高いことを示す（workDays のみ低いほど優先） */
type StaffScore = {
  preferred:    number;   // 優先現場に合致: 1 / しない: 0
  pairBonus:    number;   // ペア設定の相手が配置済みなら加点（未実装: 常に 0）
  leaderBonus:  number;   // リーダー未配置現場でリーダーに加点（未実装: 常に 0）
  levelBalance: number;   // レベル分散のための補正（未実装: 常に 0）
  workDays:     number;   // 月間勤務日数（低いほど優先）
};

/**
 * スタッフをこの現場に配置する優先度スコアを返す。
 *
 * 現在の優先順位:
 *   1. preferred — 優先現場に合致するか（true > false）
 *   2. workDays  — 月間勤務日数が少ないほど優先
 *   3. staffNo   — 安定ソート（compareByScore の外で compareStaffNo が担当）
 *
 * 将来の追加場所:
 *   - ペア設定（preferredPairs）: 相手がすでに配置済みなら pairedBonus を加算
 *   - 優先現場 clientName 対応（Phase 2）: site.clientName も照合して preferred を判定
 *   - スタッフレベル分散: 高レベル集中を抑制する levelScore を計算
 *   - リーダー加点: リーダーが0人の現場で isLeader スタッフに leaderBonus を加算
 *
 * TODO(Phase 2): preferredWorkSites を { siteName, clientName } 対応にする場合は
 *               preferred の判定を複合キー照合に変更する
 */
function scoreStaffForSite(
  s: Staff,
  site: WorkSite,
  assignedDates: Set<string>
): StaffScore {
  return {
    preferred:    (s.preferredWorkSites ?? []).includes(site.siteName) ? 1 : 0,
    pairBonus:    0,   // 未実装（将来: preferredPairs の相手が配置済みなら加点）
    leaderBonus:  0,   // 未実装（将来: isLeader かつリーダー未配置の現場で加点）
    levelBalance: 0,   // 未実装（将来: スタッフレベル分散のための補正）
    workDays:     assignedDates.size,
  };
}

/**
 * StaffScore の各項目を順番に比較する。
 * 将来 StaffScore に項目を追加した場合、ここに比較ステップを追記する。
 */
function compareByScore(
  a: Staff, scoreA: StaffScore,
  b: Staff, scoreB: StaffScore
): number {
  // 1. 優先現場スコア（高いほど優先）
  if (scoreA.preferred !== scoreB.preferred) return scoreB.preferred - scoreA.preferred;
  // 2. ペアボーナス（高いほど優先）
  if (scoreA.pairBonus !== scoreB.pairBonus) return scoreB.pairBonus - scoreA.pairBonus;
  // 3. リーダーボーナス（高いほど優先）
  if (scoreA.leaderBonus !== scoreB.leaderBonus) return scoreB.leaderBonus - scoreA.leaderBonus;
  // 4. レベル分散補正（高いほど優先）
  if (scoreA.levelBalance !== scoreB.levelBalance) return scoreB.levelBalance - scoreA.levelBalance;
  // 5. 月間勤務日数（少ないほど優先）
  if (scoreA.workDays !== scoreB.workDays) return scoreA.workDays - scoreB.workDays;
  // 6. staffNo 順（安定ソート）
  return compareStaffNo(a, b);
}

// ── 会期優先度 ────────────────────────────────────────────────
// sessionPriority はスタッフの評価ではなく「現場（会期）の充足優先度」。
// スコア加点方式では同日の競合しか解決できないため、処理順で表現する:
// 優先度の高い会期を先に処理することで、月間勤務上限・連勤枠という
// 有限リソースを優先会期が先取りする。未設定は 'normal' 扱い。
const PRIORITY_RANK: Record<'S' | 'A' | 'normal', number> = { S: 0, A: 1, normal: 2 };

function priorityRank(site: WorkSite): number {
  return PRIORITY_RANK[site.sessionPriority ?? 'normal'];
}

// ── メイン関数 ────────────────────────────────────────────────
export function generateShifts(
  staff: Staff[],
  workSites: WorkSite[]
): ShiftAssignment[] {
  // 処理順: 優先度（S → A → 通常）→ 日付昇順。同キーは安定ソートで入力順維持。
  // 全現場が優先度未設定の場合は従来（日付昇順のみ）と完全に同一の順序になる。
  // 出力配列もこの処理順で並ぶ（利用側は siteId で引くため順序に依存しない）。
  // メモ: 同日複数現場への同一スタッフ配置は現仕様では許可されている
  // （午前・午後現場など正当なケースがあるため。禁止する場合は要仕様設計）。
  const sortedSites = [...workSites.filter((s) => !s.isPlaceholder)].sort(
    (a, b) => priorityRank(a) - priorityRank(b) || a.date.localeCompare(b.date)
  );

  // 各スタッフの割当済み日付（連勤判定・月間上限判定に使用）
  const assignedDates: Record<string, Set<string>> = {};
  staff.forEach((s) => (assignedDates[s.id] = new Set()));

  const assignments: ShiftAssignment[] = [];

  for (const site of sortedSites) {
    // ── Step 1: 絶対条件フィルタ ───────────────────────────────
    const candidates = staff.filter((s) =>
      passesHardConstraints(s, site, assignedDates[s.id])
    );

    // ── Step 2: スコアリングでソート ──────────────────────────
    const scored = candidates
      .map((s) => ({ s, score: scoreStaffForSite(s, site, assignedDates[s.id]) }))
      .sort((a, b) => compareByScore(a.s, a.score, b.s, b.score));

    // ── Step 3: 上位 requiredPeople 人を選出（NGペアをスキップしながら貪欲選出）─
    const assigned: Staff[] = [];
    const assignedIds: string[] = [];
    for (const { s } of scored) {
      if (assigned.length >= site.requiredPeople) break;
      if (!passesHardConstraints(s, site, assignedDates[s.id], assignedIds)) continue;
      assigned.push(s);
      assignedIds.push(s.id);
    }
    assigned.sort(compareStaffNo);

    assigned.forEach((s) => assignedDates[s.id].add(site.date));

    if (import.meta.env.DEV) {
      const preferredCount = candidates.filter((s) => (s.preferredWorkSites ?? []).includes(site.siteName)).length;
      console.log(
        `[シフト] ${site.date} ${site.siteName}: 候補${candidates.length}人（優先${preferredCount}人）→ 選出: [${assigned.map((s) => s.name).join(', ')}]`
      );
    }

    const shortage = Math.max(0, site.requiredPeople - assigned.length);
    assignments.push({
      siteId:           site.id,
      assignedStaffIds: assigned.map((s) => s.id),
      shortage,
    });
  }

  return assignments;
}

// ── 手動調整用: 候補スタッフの理由付き評価 ─────────────────────
// シフト調整モーダル（AssignmentAdjustModal）が使用する。
// generateShifts の HARD CONSTRAINT / SOFT SCORE と同じ判定を
// 「配置しない」ではなく「人が読める警告・おすすめ理由」として返す。
// 既存思想どおり、警告があっても選択は禁止しない（判定して伝えるだけ）。
// 生成アルゴリズム本体（generateShifts）はこの追加による変更なし。

/** 候補1人分の評価結果 */
export interface CandidateEvaluation {
  /** 優先現場（siteName 完全一致）か */
  isPreferred: boolean;
  /** この現場を除く当月の割当日数（ユニーク日数） */
  assignedDayCount: number;
  /** 月間上限 */
  maxWorkDays: number;
  /** 警告文の一覧。空配列 = 制約に一切かからない「おすすめ」候補 */
  warnings: string[];
}

/**
 * スタッフをこの現場に手動追加した場合の警告を評価する。
 *
 * @param s                     評価対象スタッフ
 * @param site                  対象現場
 * @param otherAssignedDates    この現場を除く、当該スタッフの割当日集合
 * @param currentAssignedStaff  この現場に現在割当中のスタッフ（NGペア判定用）
 * @param sameDayOtherSiteNames 同日に割当済みの他現場の表示名一覧
 */
export function evaluateCandidateForSite(
  s: Staff,
  site: WorkSite,
  otherAssignedDates: Set<string>,
  currentAssignedStaff: Staff[],
  sameDayOtherSiteNames: string[],
): CandidateEvaluation {
  const warnings: string[] = [];
  const maxDays = s.maxWorkDays ?? DEFAULT_MAX_WORK_DAYS;

  // 1. 希望休
  if ((s.requestedDaysOff ?? []).includes(site.date)) {
    warnings.push('希望休の日です');
  }

  // 2. 勤務不可曜日
  if (!isAvailableOnDate(s, site.date)) {
    warnings.push(`勤務可能曜日外（${(s.availableWeekdays ?? []).join('・')}のみ勤務可）`);
  }

  // 3. 月間上限（この日が新規の勤務日になる場合のみ消費される）
  const consumesNewDay = !otherAssignedDates.has(site.date);
  if (consumesNewDay && otherAssignedDates.size >= maxDays) {
    warnings.push(`月間上限（${maxDays}日）に到達済み`);
  } else if (consumesNewDay && otherAssignedDates.size === maxDays - 1) {
    warnings.push('月間上限まで残り1日');
  }

  // 4. 最大連勤
  const consecutiveLimit = s.maxConsecutiveDays ?? DEFAULT_MAX_CONSECUTIVE_DAYS;
  if (wouldExceedConsecutive(otherAssignedDates, site.date, consecutiveLimit)) {
    warnings.push(`最大連勤（${consecutiveLimit}日）を超えます`);
  }

  // 5. NGペア（現在の割当メンバーとの組み合わせ）
  const ngWith = currentAssignedStaff.filter((a) => s.ngPartnerIds?.includes(a.id));
  if (ngWith.length > 0) {
    warnings.push(`NGペア: ${ngWith.map((a) => a.name).join('・')}`);
  }

  // 6. 同日の他現場割当（現仕様では許可されているが情報として提示）
  if (sameDayOtherSiteNames.length > 0) {
    warnings.push(`同日: ${sameDayOtherSiteNames.join('・')} に割当済み`);
  }

  return {
    isPreferred: (s.preferredWorkSites ?? []).includes(site.siteName),
    assignedDayCount: otherAssignedDates.size,
    maxWorkDays: maxDays,
    warnings,
  };
}
