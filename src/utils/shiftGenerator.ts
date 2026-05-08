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
 *   引数に alreadyAssignedIds: string[] を追加し、以下をここに実装する
 *   - NG組み合わせ: alreadyAssignedIds に NG 相手が含まれる場合 return false
 *   - 最低レベル要件: site.requiredLevel && (s.level ?? 1) < site.requiredLevel
 *   - リーダー必須現場: site.requiresLeader かつリーダー未配置なら非リーダーを除外
 */
function passesHardConstraints(
  s: Staff,
  site: WorkSite,
  assignedDates: Set<string>
): boolean {
  // 1. 希望休
  if (s.requestedDaysOff.includes(site.date)) return false;
  // 2. 勤務不可曜日
  if (!isAvailableOnDate(s, site.date)) return false;
  // 3. 月間最大勤務日数
  if (!isWithinMaxWorkDays(s, assignedDates)) return false;
  // 4. 最大連勤
  const consecutiveLimit = s.maxConsecutiveDays ?? DEFAULT_MAX_CONSECUTIVE_DAYS;
  if (wouldExceedConsecutive(assignedDates, site.date, consecutiveLimit)) return false;
  return true;
}

// ── SOFT SCORES（スコアリング関数）───────────────────────────

/** scoreStaffForSite が返すスコア内訳。高いほど優先度が高いことを示す（workDays のみ低いほど優先） */
type StaffScore = {
  preferred:     number;   // 優先現場に合致: 1 / しない: 0
  workDays:      number;   // 月間勤務日数（低いほど優先）
  pairBonus?:    number;   // ペア設定の相手が配置済みなら加点（未実装）
  leaderBonus?:  number;   // リーダー未配置現場でリーダーに加点（未実装）
  levelBalance?: number;   // レベル分散のための補正（未実装）
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
    preferred: s.preferredWorkSites.includes(site.siteName) ? 1 : 0,
    workDays:  assignedDates.size,
    // pairBonus / leaderBonus / levelBalance は未実装（将来ここに計算を追加）
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
  // 2. 追加ボーナス合計（pairBonus / leaderBonus / levelBalance）: 高いほど優先
  //    未実装時はすべて 0 なので現在の挙動に影響しない
  const bonusA = (scoreA.pairBonus ?? 0) + (scoreA.leaderBonus ?? 0) + (scoreA.levelBalance ?? 0);
  const bonusB = (scoreB.pairBonus ?? 0) + (scoreB.leaderBonus ?? 0) + (scoreB.levelBalance ?? 0);
  if (bonusA !== bonusB) return bonusB - bonusA;
  // 3. 月間勤務日数（少ないほど優先）
  if (scoreA.workDays !== scoreB.workDays) return scoreA.workDays - scoreB.workDays;
  // 4. staffNo 順（安定ソート）
  return compareStaffNo(a, b);
}

// ── メイン関数 ────────────────────────────────────────────────
export function generateShifts(
  staff: Staff[],
  workSites: WorkSite[]
): ShiftAssignment[] {
  const sortedSites = [...workSites.filter((s) => !s.isPlaceholder)].sort(
    (a, b) => a.date.localeCompare(b.date)
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

    // ── Step 3: 上位 requiredPeople 人を選出（最終ソートはstaffNo順）─
    const assigned = scored
      .slice(0, site.requiredPeople)
      .map(({ s }) => s)
      .sort(compareStaffNo);

    assigned.forEach((s) => assignedDates[s.id].add(site.date));

    if (import.meta.env.DEV) {
      const preferredCount = candidates.filter((s) => s.preferredWorkSites.includes(site.siteName)).length;
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
