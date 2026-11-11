import { useMemo, useState } from 'react';
import { Staff, WorkSite, ShiftAssignment } from '../types';
import { evaluateCandidateForSite, CandidateEvaluation } from '../utils/shiftGenerator';
import { compareStaffNo, sortedByStaffNo } from '../utils/staffUtils';
import { formatSiteLabel } from '../utils/siteUtils';

/**
 * シフト手動調整モーダル。
 *
 * 設計方針（UX設計書に基づく）:
 * - モーダル内の操作はすべてローカル状態。Firestore への反映は「保存する」の1回のみ
 *   （書き込み1回・競合警告1回・Undo スナップショット1回のトランザクション境界）
 * - 警告方式: 制約に該当する候補も ⚠ 表示付きで選択可能（ロックしない・禁止しない）
 * - 候補の判定は generateShifts と同じロジック（evaluateCandidateForSite）を共用
 * - UI は既存の .modal / .site-chip / .btn パターンを流用
 */

interface Props {
  site: WorkSite;
  staff: Staff[];
  /** 全 assignments（同日サマリー・スタッフ別割当日数の算出用） */
  assignments: ShiftAssignment[];
  /** 対象月のアクティブ現場（siteId → 日付・名称の解決用） */
  workSites: WorkSite[];
  /** モーダルを開いた時刻（保存競合警告用） */
  openedAt: number;
  /** assignments ドキュメントの最新 serverUpdatedAt */
  assignmentsServerUpdatedAt: number;
  onSave: (siteId: string, staffIds: string[]) => void;
  onClose: () => void;
}

interface CandidateRow {
  s: Staff;
  ev: CandidateEvaluation;
}

function formatDateWithDow(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dow = ['日', '月', '火', '水', '木', '金', '土'][new Date(y, m - 1, d).getDay()];
  return `${m}/${d}(${dow})`;
}

export default function AssignmentAdjustModal({
  site, staff, assignments, workSites, openedAt, assignmentsServerUpdatedAt, onSave, onClose,
}: Props) {
  const initialIds = useMemo(
    () => assignments.find((a) => a.siteId === site.id)?.assignedStaffIds ?? [],
    [assignments, site.id],
  );
  const [localIds, setLocalIds] = useState<string[]>(initialIds);
  const [closeConfirmOpen, setCloseConfirmOpen] = useState(false);
  const [sameDayOpen, setSameDayOpen] = useState(false);

  const isDirty =
    localIds.length !== initialIds.length || localIds.some((id) => !initialIds.includes(id));

  const staffIndex = useMemo(() => {
    const idx: Record<string, Staff> = {};
    staff.forEach((s) => (idx[s.id] = s));
    return idx;
  }, [staff]);

  const siteById = useMemo(() => {
    const m = new Map<string, WorkSite>();
    workSites.forEach((w) => m.set(w.id, w));
    return m;
  }, [workSites]);

  // スタッフごとの「この現場を除く割当日」と「同日の他現場名」
  const { otherDatesByStaff, sameDaySitesByStaff } = useMemo(() => {
    const dates = new Map<string, Set<string>>();
    const sameDay = new Map<string, string[]>();
    for (const a of assignments) {
      if (a.siteId === site.id) continue;
      const w = siteById.get(a.siteId);
      if (!w || !w.date) continue;
      for (const id of a.assignedStaffIds) {
        if (!dates.has(id)) dates.set(id, new Set());
        dates.get(id)!.add(w.date);
        if (w.date === site.date) {
          if (!sameDay.has(id)) sameDay.set(id, []);
          sameDay.get(id)!.push(formatSiteLabel(w.siteName, w.clientName));
        }
      }
    }
    return { otherDatesByStaff: dates, sameDaySitesByStaff: sameDay };
  }, [assignments, siteById, site.id, site.date]);

  const assignedStaff = useMemo(
    () => sortedByStaffNo(localIds, staffIndex).map((id) => staffIndex[id]).filter(Boolean),
    [localIds, staffIndex],
  );

  const evaluate = (s: Staff): CandidateEvaluation =>
    evaluateCandidateForSite(
      s,
      site,
      otherDatesByStaff.get(s.id) ?? new Set(),
      assignedStaff,
      sameDaySitesByStaff.get(s.id) ?? [],
    );

  // 候補: 未割当スタッフを評価し、警告なし → 優先現場 → 割当日数少 → staffNo 順に並べる
  const candidates: CandidateRow[] = useMemo(() => {
    return staff
      .filter((s) => !localIds.includes(s.id))
      .map((s) => ({ s, ev: evaluate(s) }))
      .sort((a, b) => {
        const warnDiff = (a.ev.warnings.length === 0 ? 0 : 1) - (b.ev.warnings.length === 0 ? 0 : 1);
        if (warnDiff !== 0) return warnDiff;
        if (a.ev.isPreferred !== b.ev.isPreferred) return a.ev.isPreferred ? -1 : 1;
        if (a.ev.assignedDayCount !== b.ev.assignedDayCount) return a.ev.assignedDayCount - b.ev.assignedDayCount;
        return compareStaffNo(a.s, b.s);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [staff, localIds, otherDatesByStaff, sameDaySitesByStaff, assignedStaff]);

  // 同日の他現場サマリー（PC で表の文脈が隠れることへの補償）
  const sameDayOtherSites = useMemo(() => {
    return workSites
      .filter((w) => w.date === site.date && w.id !== site.id && !w.isPlaceholder)
      .map((w) => {
        const a = assignments.find((x) => x.siteId === w.id);
        const names = (a?.assignedStaffIds ?? []).map((id) => staffIndex[id]?.name ?? '?');
        return { id: w.id, label: formatSiteLabel(w.siteName, w.clientName), names };
      });
  }, [workSites, assignments, staffIndex, site.date, site.id]);

  const shortage = Math.max(0, site.requiredPeople - localIds.length);
  const over     = Math.max(0, localIds.length - site.requiredPeople);
  const countLabel =
    `${localIds.length}/${site.requiredPeople}人` +
    (shortage > 0 ? `・${shortage}人不足` : over > 0 ? `（+${over}超過）` : '');

  function removeStaff(id: string) {
    setLocalIds((prev) => prev.filter((x) => x !== id));
  }

  function addStaff(id: string) {
    setLocalIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
  }

  function handleSave() {
    // 保存競合警告（既存 Phase2 と同方式: モーダルを開いた後に他ユーザーが保存していたら警告）
    if (assignmentsServerUpdatedAt > openedAt) {
      const ok = window.confirm(
        '⚠️ あなたが調整を開始した後に別ユーザーがシフトを保存しています。\n\n' +
        '保存を続行すると相手の変更を上書きする可能性があります。\n\n' +
        '「OK」で上書き保存します。キャンセルで調整を続けられます。',
      );
      if (!ok) return;
    }
    onSave(site.id, localIds);
  }

  function handleCloseAttempt() {
    if (isDirty) {
      setCloseConfirmOpen(true);
    } else {
      onClose();
    }
  }

  /** 候補行の説明文: 警告があれば警告、なければおすすめ理由 */
  function infoText(ev: CandidateEvaluation): { text: string; warn: boolean } {
    if (ev.warnings.length > 0) {
      return { text: ev.warnings.map((w) => `⚠ ${w}`).join(' / '), warn: true };
    }
    const parts: string[] = [];
    if (ev.isPreferred) parts.push('優先現場一致');
    parts.push(`今月 ${ev.assignedDayCount}/${ev.maxWorkDays}日`);
    return { text: `おすすめ: ${parts.join('・')}`, warn: false };
  }

  return (
    <div className="modal-overlay" onClick={handleCloseAttempt}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal__header">
          <h3>
            割当の調整 — {formatDateWithDow(site.date)} {formatSiteLabel(site.siteName, site.clientName)}
          </h3>
          <button className="modal__close" onClick={handleCloseAttempt}>✕</button>
        </div>

        <div className="modal__body">
          <p className="section-desc">
            {site.startTime}〜{site.endTime} ・ 必要 {site.requiredPeople}人
          </p>

          <h4 className="form-section-title">割当中（{countLabel}）</h4>
          {assignedStaff.length === 0 ? (
            <p className="section-desc">まだ誰も割り当てられていません</p>
          ) : (
            <div className="site-chips">
              {assignedStaff.map((s) => (
                <span key={s.id} className="site-chip site-chip--selected">
                  <span className="site-chip__name">
                    {s.staffNo ? `${s.staffNo}: ${s.name}` : s.name}
                  </span>
                  <button
                    type="button"
                    className="site-chip__remove"
                    onClick={() => removeStaff(s.id)}
                    aria-label={`${s.name}を外す`}
                  >×</button>
                </span>
              ))}
            </div>
          )}

          <h4 className="form-section-title">追加できるスタッフ（推奨順）</h4>
          {candidates.length === 0 ? (
            <p className="section-desc">追加できるスタッフがいません</p>
          ) : (
            <div className="candidate-list">
              {candidates.map(({ s, ev }) => {
                const info = infoText(ev);
                return (
                  <button
                    key={s.id}
                    type="button"
                    className="candidate-row"
                    onClick={() => addStaff(s.id)}
                  >
                    <span className="candidate-row__name">
                      {s.staffNo ? `${s.staffNo}: ${s.name}` : s.name}
                      {ev.isPreferred && ' ★'}
                    </span>
                    <span className={info.warn ? 'candidate-row__info candidate-row__info--warn' : 'candidate-row__info'}>
                      {info.text}
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {sameDayOtherSites.length > 0 && (
            <div className="sameday-summary">
              <button
                type="button"
                className="preferred-add__toggle"
                onClick={() => setSameDayOpen((v) => !v)}
              >
                この日の他現場の割当を見る
                <span className="preferred-add__chevron">{sameDayOpen ? '▲' : '▼'}</span>
              </button>
              {sameDayOpen && (
                <div className="sameday-summary__list">
                  {sameDayOtherSites.map((w) => (
                    <p key={w.id} className="section-desc">
                      {w.label}: {w.names.length > 0 ? w.names.join('、') : '未割当'}
                    </p>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="modal__footer">
          <button className="btn btn--secondary" onClick={handleCloseAttempt}>キャンセル</button>
          <button className="btn btn--primary" onClick={handleSave} disabled={!isDirty}>
            保存する
          </button>
        </div>

        {/* 未保存変更ありで閉じようとした場合の3択（既存 modal スタイルを流用した内側ダイアログ） */}
        {closeConfirmOpen && (
          <div className="modal-overlay modal-overlay--inner" onClick={(e) => e.stopPropagation()}>
            <div className="modal modal--narrow">
              <div className="modal__header">
                <h3>変更が保存されていません</h3>
              </div>
              <div className="modal__body">
                <p className="section-desc">この調整内容を保存しますか？</p>
              </div>
              <div className="modal__footer">
                <button className="btn btn--ghost" onClick={() => setCloseConfirmOpen(false)}>
                  キャンセル
                </button>
                <button className="btn btn--secondary" onClick={onClose}>
                  保存せず閉じる
                </button>
                <button
                  className="btn btn--primary"
                  onClick={() => { setCloseConfirmOpen(false); handleSave(); }}
                >
                  保存する
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
