// 案件詳細。下部のシートタブ（基本情報／スタッフ配置／レイアウト／試算）で切り替える。
import { ReactNode, useMemo, useState } from 'react';
import { assignmentHours, estimate, laborLine, unitMaterialCost } from '../domain/calc';
import { applyTemplate } from '../domain/layout';
import { genId, listDates, num, shortDate, toMinutes, yen } from '../domain/util';
import { checkNewAssignment, projectWarnings } from '../domain/warnings';
import { AppData, Assignment, OtherCost, Project, ProjectContent, ProjectStatus, Venue, Warning } from '../types';
import Grid, { Col, n0, nNull } from './Grid';
import LayoutEditor from './LayoutEditor';
import NumInput from './NumInput';

type Sheet = 'basic' | 'staff' | 'layout' | 'estimate';
const SHEETS: { id: Sheet; label: string }[] = [
  { id: 'basic', label: '基本情報' },
  { id: 'staff', label: 'スタッフ配置' },
  { id: 'layout', label: 'レイアウト' },
  { id: 'estimate', label: '試算' },
];
const STATUSES: ProjectStatus[] = ['計画中', '確定', '実施済', '中止'];

interface Props {
  project: Project;
  data: AppData;
  onChange: (fn: (p: Project) => Project) => void;
  onSaveVenueTemplate: (venueId: string, project: Project) => void;
  onBack: () => void;
}

function Field({ label, warn, children }: { label: string; warn?: string; children: ReactNode }) {
  return (
    <tr>
      <th className="kv__label">{label}</th>
      <td className={warn ? 'is-warn' : ''} title={warn}>{children}{warn && <span className="grid__warnmark">⚠</span>}</td>
    </tr>
  );
}

export default function ProjectView({ project: p, data, onChange, onSaveVenueTemplate, onBack }: Props) {
  const [sheet, setSheet] = useState<Sheet>('basic');
  const [showWarn, setShowWarn] = useState(false);
  const warnings = useMemo(() => projectWarnings(p, data), [p, data]);
  const est = useMemo(() => estimate(p, data), [p, data]);
  const venue = data.venues.find((v) => v.id === p.venueId);
  const dates = useMemo(() => listDates(p.startDate, p.endDate), [p.startDate, p.endDate]);
  const wOf = (target: string) => warnings.find((w) => w.target === target)?.message;
  const set = (patch: Partial<Project>) => onChange((x) => ({ ...x, ...patch }));
  const nWarn = warnings.filter((w) => w.severity === 'warn').length;
  const nInfo = warnings.length - nWarn;

  // ── 会場変更: 置き換えるかどうかは利用者が選ぶ ──
  const changeVenue = (venueId: string) => {
    const v = data.venues.find((x) => x.id === venueId);
    if (!v) { set({ venueId }); return; }
    const hasEnv = p.layout.env.length > 0;
    const replace = !hasEnv || window.confirm(
      `会場を「${v.name}」に変更します。\nレイアウトの周辺環境と会場費を、この会場の雛形・既定値に置き換えますか？\n\n` +
      '［OK］置き換える（配置済みパーツは残ります）\n［キャンセル］会場名だけ変更する',
    );
    onChange((x) => (replace
      ? {
          ...x, venueId,
          venueFeeFixed: v.feeFixed, venueFeePerDay: v.feePerDay, venueFeeRatePct: v.feeRatePct,
          // 図が変わるので、出力済みの版なら次の版になる（applyTemplate 内で繰り上げ）
          layout: applyTemplate(x.layout, v.template),
        }
      : { ...x, venueId }));
  };

  // ── スタッフ配置 ──
  const defaultBreak = () => {
    const s = toMinutes(p.openTime), e = toMinutes(p.closeTime);
    return s != null && e != null && e - s > 360 ? 60 : 0;
  };
  const makeAssignment = (staffId: string, date: string): Assignment => ({
    id: genId(), staffId, date, startTime: p.openTime, endTime: p.closeTime, breakMinutes: defaultBreak(),
    rateOverride: null, transportOverride: null, memo: '',
  });
  const toggleCell = (staffId: string, date: string) => {
    const existing = p.assignments.filter((a) => a.staffId === staffId && a.date === date);
    if (existing.length > 0) {
      const ids = new Set(existing.map((a) => a.id));
      onChange((x) => ({ ...x, assignments: x.assignments.filter((a) => !ids.has(a.id)) }));
      return;
    }
    const a = makeAssignment(staffId, date);
    const ws = checkNewAssignment(a, p, data);
    // 禁止はしない。警告を見せて、配置するかどうかを選んでもらう
    if (ws.length > 0 && !window.confirm(`⚠ 警告\n${ws.map((m) => `・${m}`).join('\n')}\n\nこのまま配置しますか？`)) return;
    onChange((x) => ({ ...x, assignments: [...x.assignments, a] }));
  };

  const staffOptions = data.staff.map((s) => ({ value: s.id, label: s.name }));
  const dateOptions = dates.map((d) => ({ value: d, label: shortDate(d) }));
  const aw = (a: Assignment, f: string) => wOf(`assign:${a.id}:${f}`);
  const assignCols: Col<Assignment>[] = [
    { key: 'date', title: '日付', width: 110, type: dates.length ? 'select' : 'date', options: dateOptions, get: (a) => a.date, set: (a, v) => ({ ...a, date: v }), warn: (a) => aw(a, 'date') },
    { key: 'staffId', title: 'スタッフ', width: 170, type: 'select', options: staffOptions, get: (a) => a.staffId, set: (a, v) => ({ ...a, staffId: v }), warn: (a) => aw(a, 'staffId') },
    { key: 'startTime', title: '開始', width: 86, type: 'time', get: (a) => a.startTime, set: (a, v) => ({ ...a, startTime: v }) },
    { key: 'endTime', title: '終了', width: 86, type: 'time', get: (a) => a.endTime, set: (a, v) => ({ ...a, endTime: v }), warn: (a) => aw(a, 'endTime') },
    { key: 'breakMinutes', title: '休憩(分)', width: 72, type: 'number', get: (a) => a.breakMinutes, set: (a, v) => ({ ...a, breakMinutes: n0(v) }), warn: (a) => aw(a, 'breakMinutes') },
    {
      key: 'rate', title: '時給', width: 80, type: 'number', get: (a) => a.rateOverride, set: (a, v) => ({ ...a, rateOverride: nNull(v) }),
      placeholder: (a) => String(data.staff.find((s) => s.id === a.staffId)?.hourlyRate ?? ''), warn: (a) => aw(a, 'rate'),
    },
    {
      key: 'transport', title: '交通費', width: 80, type: 'number', get: (a) => a.transportOverride, set: (a, v) => ({ ...a, transportOverride: nNull(v) }),
      placeholder: (a) => String(data.staff.find((s) => s.id === a.staffId)?.transportPerDay ?? ''),
    },
    { key: 'hours', title: '実働(h)', width: 70, type: 'readonly', align: 'right', get: (a) => assignmentHours(a).toFixed(2) },
    { key: 'cost', title: '人件費', width: 90, type: 'readonly', align: 'right', get: (a) => yen(laborLine(a, data.staff.find((s) => s.id === a.staffId)).total) },
    { key: 'memo', title: 'メモ', width: 180, get: (a) => a.memo, set: (a, v) => ({ ...a, memo: v }) },
  ];

  // ── コンテンツ・その他費用 ──
  const contentOptions = data.contents.map((c) => ({ value: c.id, label: c.name }));
  const lineOf = (pc: ProjectContent) => est.contentLines.find((l) => l.id === pc.id);
  const pcCols: Col<ProjectContent>[] = [
    { key: 'contentId', title: 'コンテンツ', width: 200, type: 'select', options: contentOptions, get: (c) => c.contentId, set: (c, v) => ({ ...c, contentId: v }), warn: (c) => wOf(`pc:${c.id}:contentId`) },
    { key: 'plannedCount', title: '予定個数（期間計）', width: 130, type: 'number', get: (c) => c.plannedCount, set: (c, v) => ({ ...c, plannedCount: n0(v) }), warn: (c) => wOf(`pc:${c.id}:plannedCount`) },
    {
      key: 'price', title: '参加費/個', width: 90, type: 'number', get: (c) => c.priceOverride, set: (c, v) => ({ ...c, priceOverride: nNull(v) }),
      placeholder: (c) => String(data.contents.find((x) => x.id === c.contentId)?.price ?? ''),
    },
    { key: 'sparePct', title: '予備率(%)', width: 80, type: 'number', get: (c) => c.sparePct, set: (c, v) => ({ ...c, sparePct: n0(v) }) },
    {
      // 任意。入力すると、制作席が足りない計算のときに警告する（空欄なら警告しない）
      key: 'maxTurns', title: '上限回転数(回/席・日)', width: 150, type: 'number', get: (c) => c.maxTurns ?? null, set: (c, v) => ({ ...c, maxTurns: nNull(v) }),
      placeholder: () => '任意', warn: (c) => wOf(`pc:${c.id}:maxTurns`) ?? (num(c.maxTurns) > 0 ? wOf('layout:seats') : undefined),
    },
    { key: 'unit', title: '材料原価/個', width: 100, type: 'readonly', align: 'right', get: (c) => yen(unitMaterialCost(data.contents.find((x) => x.id === c.contentId))) },
    { key: 'mat', title: '材料費', width: 100, type: 'readonly', align: 'right', get: (c) => yen(lineOf(c)?.materialCost ?? 0) },
    { key: 'rev', title: '参加費売上', width: 100, type: 'readonly', align: 'right', get: (c) => yen(lineOf(c)?.revenue ?? 0) },
  ];
  const ocCols: Col<OtherCost>[] = [
    { key: 'name', title: '費目', width: 240, get: (o) => o.name, set: (o, v) => ({ ...o, name: v }) },
    { key: 'amount', title: '金額', width: 110, type: 'number', get: (o) => o.amount, set: (o, v) => ({ ...o, amount: n0(v) }) },
  ];

  const numInput = (key: 'fixedRevenue' | 'venueFeeFixed' | 'venueFeePerDay' | 'venueFeeRatePct') => (
    <NumInput value={String(p[key] ?? '')} blankIsZero onValue={(v) => set({ [key]: n0(v) })} style={{ textAlign: 'right' }} />
  );

  return (
    <div className="pv">
      <div className="pv__head">
        <button onClick={onBack}>← 案件一覧</button>
        <h2>{p.name || '（名称未設定）'}<small>{venue?.name ?? '会場未選択'}{dates.length ? `・${shortDate(dates[0])}〜${shortDate(dates[dates.length - 1])}（${dates.length}日間）` : ''}</small></h2>
        <span className="pv__profit">利益 <b className={est.profit < 0 ? 'neg' : ''}>{yen(est.profit)}</b></span>
        <button className={`warnbtn${nWarn ? ' warnbtn--on' : ''}`} onClick={() => setShowWarn((v) => !v)}>
          ⚠ 警告 {nWarn}件{nInfo > 0 ? `・参考 ${nInfo}件` : ''} {showWarn ? '▲' : '▼'}
        </button>
      </div>
      {showWarn && (
        <ul className="warnlist">
          {warnings.length === 0 && <li>警告はありません。</li>}
          {warnings.map((w: Warning, i) => <li key={i} className={`warnlist__${w.severity}`}>{w.severity === 'warn' ? '⚠' : 'ℹ'} {w.message}</li>)}
        </ul>
      )}

      <div className="pv__body">
        {sheet === 'basic' && (
          <>
            <table className="grid kv">
              <tbody>
                <Field label="案件名（図面タイトルの先頭）" warn={wOf('project:name')}><input value={p.name} onChange={(e) => set({ name: e.target.value })} /></Field>
                <Field label="会場" warn={wOf('project:venueId')}>
                  <select value={p.venueId} onChange={(e) => changeVenue(e.target.value)}>
                    <option value="">（選択）</option>
                    {data.venues.map((v: Venue) => <option key={v.id} value={v.id}>{v.name}</option>)}
                  </select>
                </Field>
                <Field label="開始日"><input type="date" value={p.startDate} onChange={(e) => set({ startDate: e.target.value })} /></Field>
                <Field label="終了日" warn={wOf('project:endDate')}><input type="date" value={p.endDate} onChange={(e) => set({ endDate: e.target.value })} /></Field>
                <Field label="スタッフ既定時間（開始）"><input type="time" value={p.openTime} onChange={(e) => set({ openTime: e.target.value })} /></Field>
                <Field label="スタッフ既定時間（終了）"><input type="time" value={p.closeTime} onChange={(e) => set({ closeTime: e.target.value })} /></Field>
                <Field label="状態">
                  <select value={p.status} onChange={(e) => set({ status: e.target.value as ProjectStatus })}>
                    {STATUSES.map((s) => <option key={s}>{s}</option>)}
                  </select>
                </Field>
                <Field label="固定売上（受託料など）">{numInput('fixedRevenue')}</Field>
                <Field label="会場費：固定額">{numInput('venueFeeFixed')}</Field>
                <Field label="会場費：1日あたり">{numInput('venueFeePerDay')}</Field>
                <Field label="会場費：参加費売上の歩合(%)">{numInput('venueFeeRatePct')}</Field>
                <Field label="メモ"><input value={p.memo} onChange={(e) => set({ memo: e.target.value })} /></Field>
              </tbody>
            </table>

            <h3>実施コンテンツ</h3>
            <Grid
              rows={p.contents} cols={pcCols} rowKey={(c) => c.id} deletable
              onChange={(rows) => set({ contents: rows })}
              onAdd={() => set({ contents: [...p.contents, { id: genId(), contentId: data.contents[0]?.id ?? '', plannedCount: 0, priceOverride: null, sparePct: 0 }] })}
              addLabel="＋ コンテンツを追加"
              emptyText="実施するコンテンツを追加してください（コンテンツ自体は「コンテンツ」マスタで登録）"
            />

            <h3>その他費用</h3>
            <Grid
              rows={p.otherCosts} cols={ocCols} rowKey={(o) => o.id} deletable
              onChange={(rows) => set({ otherCosts: rows })}
              onAdd={() => set({ otherCosts: [...p.otherCosts, { id: genId(), name: '', amount: 0 }] })}
              addLabel="＋ 費目を追加" emptyText="印刷費・送料・駐車場代など"
            />
          </>
        )}

        {sheet === 'staff' && (
          <>
            <h3>配置表<small>セルをクリックして配置／解除（時間は既定 {p.openTime}〜{p.closeTime}。細かい調整は下の明細で）</small></h3>
            {dates.length === 0 || data.staff.length === 0 ? (
              <p className="hint">{dates.length === 0 ? '基本情報で期間（開始日・終了日）を入力すると配置表が表示されます。' : '「スタッフ」マスタにスタッフを登録してください。'}</p>
            ) : (
              <div className="grid-wrap">
                <table className="grid matrix">
                  <thead>
                    <tr><th className="grid__corner" /><th style={{ minWidth: 170 }}>スタッフ</th>
                      {dates.map((d) => <th key={d} className={wOf(`day:${d}`) ? 'is-info' : ''} title={wOf(`day:${d}`)}>{shortDate(d)}</th>)}
                      <th>勤務日数</th></tr>
                  </thead>
                  <tbody>
                    {data.staff.map((s, i) => (
                      <tr key={s.id}>
                        <th className="grid__rownum">{i + 1}</th>
                        <td className="is-ro"><div className="grid__ro">{s.name}</div></td>
                        {dates.map((d) => {
                          const as = p.assignments.filter((a) => a.staffId === s.id && a.date === d);
                          const warn = as.some((a) => warnings.some((w) => w.severity === 'warn' && w.target.startsWith(`assign:${a.id}:`)));
                          return (
                            <td key={d} className={`matrix__cell${as.length ? ' is-on' : ''}${warn ? ' is-warn' : ''}`}>
                              <button onClick={() => toggleCell(s.id, d)} aria-label={`${s.name} ${shortDate(d)}`}>
                                {as.length ? as.map((a) => `${a.startTime}-${a.endTime}`).join(' / ') : '　'}
                              </button>
                            </td>
                          );
                        })}
                        <td className="is-ro"><div className="grid__ro" style={{ textAlign: 'right' }}>{new Set(p.assignments.filter((a) => a.staffId === s.id).map((a) => a.date)).size}</div></td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr><th className="grid__rownum">計</th><td>配置人数</td>
                      {dates.map((d) => <td key={d} style={{ textAlign: 'center' }}>{new Set(p.assignments.filter((a) => a.date === d).map((a) => a.staffId)).size}人</td>)}
                      <td /></tr>
                  </tfoot>
                </table>
              </div>
            )}

            <h3>配置明細<small>時給・交通費は空欄ならスタッフマスタの値（薄い文字）を使います</small></h3>
            <Grid
              rows={p.assignments} cols={assignCols} rowKey={(a) => a.id} deletable
              onChange={(rows) => set({ assignments: rows })}
              onAdd={() => set({ assignments: [...p.assignments, makeAssignment('', dates[0] ?? '')] })}
              addLabel="＋ 配置を追加"
              footer={[null, null, null, null, null, null, null, est.totalHours.toFixed(2), yen(est.laborCost), null]}
              emptyText="まだ誰も配置されていません"
            />
          </>
        )}

        {sheet === 'layout' && (
          <LayoutEditor
            mode="project" layout={p.layout} partTypes={data.partTypes} composites={data.composites}
            projectName={p.name} venueName={venue?.name ?? ''} startDate={p.startDate} endDate={p.endDate} warnings={warnings}
            onChange={(layout) => onChange((x) => ({ ...x, layout }))}
            onReloadTemplate={venue ? () => {
              if (!window.confirm(`周辺環境を会場「${venue.name}」の雛形で置き換えます（配置済みパーツは残ります）。よろしいですか？`)) return;
              onChange((x) => ({ ...x, layout: applyTemplate(x.layout, venue.template) }));
            } : undefined}
            onSaveAsTemplate={venue ? () => {
              if (window.confirm(`この周辺環境を会場「${venue.name}」の雛形として保存します。今後この会場で作る案件の初期状態になります。よろしいですか？`)) onSaveVenueTemplate(venue.id, p);
            } : undefined}
          />
        )}

        {sheet === 'estimate' && (
          <div className="est">
            <table className="grid est__summary">
              <thead><tr><th className="grid__corner" /><th>項目</th><th style={{ width: 130 }}>金額</th><th>計算式</th></tr></thead>
              <tbody>
                {([
                  ['参加費売上', est.participationRevenue, 'Σ 予定個数 × 参加費', ''],
                  ['固定売上', est.fixedRevenue, '受託料など（基本情報）', ''],
                  ['売上 計', est.revenue, '', 'sum'],
                  ['人件費', est.laborCost, 'Σ（実働時間 × 時給 ＋ 交通費）', ''],
                  ['材料費', est.materialCost, 'Σ 予定個数 ×（1＋予備率）× 1個あたり材料原価', ''],
                  ['会場費', est.venueFee, `固定額 ＋ 日額 × ${est.days}日 ＋ 参加費売上 × 歩合`, ''],
                  ['備品費（レイアウト連動）', est.partsCost, 'Σ 配置個数 × 単価（日額のものは × 日数）', ''],
                  ['その他費用', est.otherCost, '基本情報の「その他費用」の合計', ''],
                  ['費用 計', est.totalCost, '', 'sum'],
                  ['利益', est.profit, '売上 計 − 費用 計', 'total'],
                ] as [string, number, string, string][]).map(([label, v, formula, cls], i) => (
                  <tr key={label} className={cls ? `est__${cls}` : ''}>
                    <th className="grid__rownum">{i + 1}</th>
                    <td className="is-ro"><div className="grid__ro">{label}</div></td>
                    <td className="is-ro"><div className={`grid__ro num${v < 0 ? ' neg' : ''}`}>{yen(v)}</div></td>
                    <td className="is-ro"><div className="grid__ro formula">{formula}</div></td>
                  </tr>
                ))}
                <tr><th className="grid__rownum">11</th><td className="is-ro"><div className="grid__ro">利益率</div></td>
                  <td className="is-ro"><div className="grid__ro num">{est.marginPct == null ? '—' : `${est.marginPct.toFixed(1)}%`}</div></td>
                  <td className="is-ro"><div className="grid__ro formula">利益 ÷ 売上 計</div></td></tr>
                <tr><th className="grid__rownum">12</th><td className="is-ro"><div className="grid__ro">参考: 総労働時間／制作席／その他の椅子</div></td>
                  <td className="is-ro"><div className="grid__ro num" data-testid="est-seats">{est.totalHours.toFixed(1)}h／制作席 {est.seats}席／その他 {est.otherSeats}脚</div></td>
                  <td className="is-ro"><div className="grid__ro formula">制作席＝レイアウトの椅子のうち、役割が「制作席」のもの（役割はパーツ画面で設定）</div></td></tr>
                <tr><th className="grid__rownum">13</th><td className="is-ro"><div className="grid__ro">参考: 必要な回転数（制作席 1 席・1 日あたり）</div></td>
                  <td className={wOf('layout:seats') ? 'is-warn' : 'is-ro'} title={wOf('layout:seats')}><div className="grid__ro num" data-testid="est-turns">{est.requiredTurns == null ? '—' : `${est.requiredTurns.toFixed(1)}回`}</div></td>
                  <td className="is-ro"><div className="grid__ro formula">Σ 予定個数 ÷（制作席 × {est.days}日）。実施コンテンツに「上限回転数」を入力すると、席が足りない計算のときに警告します</div></td></tr>
              </tbody>
            </table>

            <h3>人件費の内訳</h3>
            <Grid
              rows={est.laborLines} rowKey={(l) => l.assignmentId}
              cols={[
                { key: 'date', title: '日付', width: 100, get: (l) => shortDate(l.date) },
                { key: 'name', title: 'スタッフ', width: 170, get: (l) => l.staffName },
                { key: 'hours', title: '実働(h)', width: 80, align: 'right', get: (l) => l.hours.toFixed(2) },
                { key: 'rate', title: '時給', width: 80, align: 'right', get: (l) => yen(l.rate) },
                { key: 'wage', title: '賃金', width: 90, align: 'right', get: (l) => yen(l.wage) },
                { key: 'tr', title: '交通費', width: 80, align: 'right', get: (l) => yen(l.transport) },
                { key: 'total', title: '小計', width: 100, align: 'right', get: (l) => yen(l.total) },
              ]}
              footer={[null, null, est.totalHours.toFixed(2), null, null, null, yen(est.laborCost)]}
              emptyText="スタッフ配置がありません"
            />

            <h3>材料費の内訳</h3>
            <Grid
              rows={est.contentLines} rowKey={(l) => l.id}
              cols={[
                { key: 'name', title: 'コンテンツ', width: 200, get: (l) => l.name },
                { key: 'count', title: '予定個数', width: 90, align: 'right', get: (l) => l.count },
                { key: 'spare', title: '予備率', width: 70, align: 'right', get: (l) => `${l.sparePct}%` },
                { key: 'unit', title: '材料原価/個', width: 100, align: 'right', get: (l) => yen(l.unitMaterialCost) },
                { key: 'mat', title: '材料費', width: 100, align: 'right', get: (l) => yen(l.materialCost) },
                { key: 'rev', title: '参加費売上', width: 100, align: 'right', get: (l) => yen(l.revenue) },
              ]}
              footer={[null, est.contentLines.reduce((s, l) => s + l.count, 0), null, null, yen(est.materialCost), yen(est.participationRevenue)]}
              emptyText="実施コンテンツがありません"
            />

            <h3>備品（レイアウトの配置個数と連動）</h3>
            <Grid
              rows={est.partLines} rowKey={(l) => l.partTypeId}
              cols={[
                { key: 'name', title: 'パーツ', width: 240, get: (l) => l.name },
                { key: 'count', title: '配置個数', width: 90, align: 'right', get: (l) => l.count, warn: (l) => wOf(`part:${l.partTypeId}`) },
                { key: 'stock', title: '保有数', width: 80, align: 'right', get: (l) => (l.stockQty > 0 ? l.stockQty : '—') },
                { key: 'unit', title: '単価', width: 90, align: 'right', get: (l) => `${yen(l.unitCost)}${l.costUnit === 'day' ? '/日' : ''}` },
                { key: 'cost', title: '費用', width: 100, align: 'right', get: (l) => yen(l.cost) },
              ]}
              footer={[null, est.partLines.reduce((s, l) => s + num(l.count), 0), null, null, yen(est.partsCost)]}
              emptyText="レイアウトにパーツが配置されていません"
            />
          </div>
        )}
      </div>

      <nav className="sheettabs">
        {SHEETS.map((s) => (
          <button key={s.id} className={sheet === s.id ? 'is-on' : ''} onClick={() => setSheet(s.id)}>{s.label}</button>
        ))}
      </nav>
    </div>
  );
}
