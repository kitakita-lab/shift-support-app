// JCOS 案件の収支（試算シート）。請求（売上）と実費（こちらの支払い）を分けて見せる。
// 計算は domain/jcos.ts。ここは表示と、日ごとの入力（請求する／しない・アルバイトの人数・実績個数の手入力）だけ。
import { Estimate } from '../domain/calc';
import { JcosEstimate, jcosExcluded, withJcosDay } from '../domain/jcos';
import { shortDate, yen } from '../domain/util';
import { Project } from '../types';
import NumInput from './NumInput';

interface Props {
  project: Project;
  /** JCOS の収支 */
  j: JcosEstimate;
  /** 汎用の試算（JCOS の計算に入れていない項目を示すため） */
  generic: Estimate;
  onChange: (fn: (p: Project) => Project) => void;
}

const signed = (v: number): string => (v < 0 ? `−${yen(-v)}` : yen(v));

export default function JcosView({ project: p, j, generic, onChange }: Props) {
  const t = j.current;
  const terms = j.terms;
  const excluded = jcosExcluded(generic);
  const setDay = (date: string, patch: { billed?: boolean; partTimers?: number }) =>
    onChange((x) => (x.jcos ? { ...x, jcos: withJcosDay(x.jcos, date, patch) } : x));
  const setManual = (date: string, v: string) => onChange((x) => {
    const next = { ...(x.actualsManual ?? {}) };
    const n = v === '' ? null : Number(v);
    if (n == null || !Number.isFinite(n) || n < 0) delete next[date];
    else next[date] = n;
    return { ...x, actualsManual: next };
  });

  const basisText = j.basis === 'actual'
    ? `全 ${j.periodDays} 日の実績（${j.actualCount} 個）で計算`
    : j.basis === 'mixed'
      ? `実績 ${j.actualDays} 日分（${j.actualCount} 個）＋ 残り ${j.periodDays - j.actualDays} 日は予定個数で計算`
      : j.periodDays === 0 ? '会期（開始日・終了日）が未入力です' : `予定個数（${j.plannedCount} 個）で計算した見込み。実績はまだありません`;
  const plannedOnly = j.planned.count - j.days.filter((d) => d.actual).reduce((s, d) => s + d.plannedCount, 0);

  const rows: [string, number, string, string][] = [
    ['請求：人件費', t.billLabor, `${yen(terms.billLaborPerDay)} × 請求 ${j.billDays} 日`, ''],
    ['請求：材料費', t.billMaterial, `${yen(terms.billMaterialPerDay)} × 請求 ${j.billDays} 日`, ''],
    ['請求：追加（予備費など）', t.extraBilling, '基本情報の「追加の請求」の合計', ''],
    ['請求 計（売上）', t.billing, '', 'sum'],
    ['実費：アルバイト代', t.partTimerCost, `${yen(terms.partTimerPerDay)} × 稼働 ${j.partTimerDays} 人日`, ''],
    ['実費：材料原価', t.materialCost, j.basis === 'planned'
      ? `${yen(terms.unitCost)} × 予定 ${t.count} 個`
      : j.basis === 'actual' ? `${yen(terms.unitCost)} × 実績 ${t.count} 個` : `${yen(terms.unitCost)} ×（実績 ${j.actualCount} 個 ＋ 予定 ${plannedOnly} 個）`, ''],
    ['実費：その他', t.otherCost, '基本情報の「その他実費」の合計（入力したものだけ）', ''],
    ['実費 計', t.cost, '', 'sum'],
    ['粗利（管理上）', t.gross, '請求 計 − 実費 計', 'total'],
  ];

  return (
    <div className="est jcos" data-testid="jcos-view" data-basis={j.basis}>
      <div className="cards">
        <div className={`card card--main${t.gross < 0 ? ' card--neg' : ''}`}>
          <div className="card__label">粗利（管理上）</div>
          <div className="card__value" data-testid="jcos-gross">{signed(t.gross)}</div>
          <div className="card__note">{t.marginPct == null ? '' : `粗利率 ${t.marginPct.toFixed(1)}%・`}<span data-testid="jcos-basis">{basisText}</span></div>
        </div>
        <div className="card">
          <div className="card__label">請求 計（JCOS へ）</div>
          <div className="card__value" data-testid="jcos-billing">{yen(t.billing)}</div>
          <div className="card__note">請求 {j.billDays} 日／会期 {j.periodDays} 日</div>
        </div>
        <div className="card">
          <div className="card__label">実費 計（支払い）</div>
          <div className="card__value" data-testid="jcos-cost">{yen(t.cost)}</div>
          <div className="card__note">アルバイト {j.partTimerDays} 人日・{t.count} 個</div>
        </div>
      </div>
      <p className="hint">
        粗利（管理上）＝ JCOS への請求 − 実際の支払い。自分たちの稼働の原価や税金は含まない、管理のための数字です（最終的な利益ではありません）。
      </p>

      <table className="grid est__summary jcos__summary">
        <thead><tr><th className="grid__corner" /><th>項目</th><th style={{ width: 130 }}>金額</th><th>計算式</th></tr></thead>
        <tbody>
          {rows.map(([label, v, formula, cls], i) => (
            <tr key={label} className={cls ? `est__${cls}` : ''}>
              <th className="grid__rownum">{i + 1}</th>
              <td className="is-ro"><div className="grid__ro est__label" data-formula={formula}>{label}</div></td>
              <td className="is-ro"><div className={`grid__ro num${v < 0 ? ' neg' : ''}`}>{signed(v)}</div></td>
              <td className="is-ro est__fcol"><div className="grid__ro formula">{formula}</div></td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className={`panel panel--wide matbox${t.materialOver > 0 ? ' matbox--over' : ''}`} data-testid="jcos-material">
        <div className="panel__title">材料費：請求と原価</div>
        <div className="matbox__row">
          <span>請求 <b>{yen(t.billMaterial)}</b></span>
          <span>原価 <b>{yen(t.materialCost)}</b>（{t.count} 個 × {yen(terms.unitCost)}）</span>
          {t.materialOver > 0
            ? <span className="neg">超過 <b data-testid="jcos-over">{yen(t.materialOver)}</b>（自己負担）</span>
            : <span>請求の範囲内（残り <b data-testid="jcos-over">{yen(t.billMaterial - t.materialCost)}</b>）</span>}
        </div>
      </div>

      <div className="panel panel--wide">
        <div className="panel__title">予定と実績</div>
        <div className="matbox__row">
          <span>予定 <b>{j.plannedCount}</b> 個</span>
          <span>実績 <b data-testid="jcos-actual">{j.actualCount}</b> 個（{j.actualDays}／{j.periodDays} 日）</span>
          <span>予定だけで計算した粗利 <b className={j.planned.gross < 0 ? 'neg' : ''} data-testid="jcos-planned-gross">{signed(j.planned.gross)}</b></span>
          {j.basis === 'mixed' && <span>実績のある {j.reported.days} 日分の小計 <b className={j.reported.gross < 0 ? 'neg' : ''}>{signed(j.reported.gross)}</b></span>}
        </div>
      </div>

      <h3>日別<small>「請求」のチェックと「アルバイト」の人数は、日ごとに変えられます。実績個数は、日報の同期で入ります（同期できないときは手入力）</small></h3>
      {j.days.length === 0 ? <p className="hint">基本情報で会期（開始日・終了日）を入力すると、日別の表が表示されます。</p> : (
        <div className="grid-wrap">
          <table className="grid daygrid" data-testid="jcos-days">
            <thead>
              <tr><th>日付</th><th>請求</th><th>アルバイト</th><th>予定個数</th><th>実績個数</th><th>材料原価</th><th>粗利</th></tr>
            </thead>
            <tbody>
              {j.days.map((d) => (
                <tr key={d.date} data-testid={`jcos-day-${d.date}`} data-basis={d.basis}>
                  <td className="is-ro daygrid__date" data-label="日付"><div className="grid__ro">{shortDate(d.date)}</div></td>
                  <td data-label="請求">
                    <label className="check">
                      <input type="checkbox" checked={d.billed} onChange={(e) => setDay(d.date, { billed: e.target.checked })} aria-label={`${shortDate(d.date)} を請求する`} />
                      <span>{d.billed ? yen(d.billing) : '請求しない'}</span>
                    </label>
                  </td>
                  <td data-label="アルバイト">
                    <div className="stepper stepper--inline">
                      <button onClick={() => setDay(d.date, { partTimers: Math.max(0, d.partTimers - 1) })} disabled={d.partTimers <= 0} aria-label={`${shortDate(d.date)} のアルバイトを減らす`}>−</button>
                      <span>{d.partTimers}人</span>
                      <button onClick={() => setDay(d.date, { partTimers: d.partTimers + 1 })} aria-label={`${shortDate(d.date)} のアルバイトを増やす`}>＋</button>
                      <small>{yen(d.partTimerCost)}</small>
                    </div>
                  </td>
                  <td className="is-ro" data-label="予定個数"><div className="grid__ro num">{Number.isInteger(d.plannedCount) ? d.plannedCount : d.plannedCount.toFixed(1)}</div></td>
                  <td data-label="実績個数" className={d.actual?.source === 'report' ? 'is-ro' : ''}>
                    {d.actual?.source === 'report' ? (
                      <div className="grid__ro num">
                        <b>{d.actual.count}</b> <small className="tag">日報{d.actual.rows > 1 ? ` ${d.actual.rows}件` : ''}</small>
                        {d.manualIgnored != null && <small className="daygrid__note">手入力 {d.manualIgnored} は使っていません</small>}
                      </div>
                    ) : (
                      <NumInput
                        value={d.actual ? String(d.actual.count) : ''} placeholder="未入力" style={{ textAlign: 'right' }}
                        aria-label={`${shortDate(d.date)} の実績個数（手入力）`} onValue={(v) => setManual(d.date, v)}
                      />
                    )}
                  </td>
                  <td className="is-ro" data-label="材料原価">
                    <div className="grid__ro num">{yen(d.materialCost)}{d.materialOver > 0 && <small className="neg daygrid__note">超過 {yen(d.materialOver)}</small>}</div>
                  </td>
                  <td className="is-ro" data-label="粗利">
                    <div className={`grid__ro num${d.gross < 0 ? ' neg' : ''}`}><b>{signed(d.gross)}</b> <small className={`tag${d.basis === 'actual' ? ' tag--on' : ''}`}>{d.basis === 'actual' ? '実績' : '予定'}</small></div>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td data-label="">日別の計</td>
                <td data-label="請求">{yen(t.billLabor + t.billMaterial)}</td>
                <td data-label="アルバイト">{j.partTimerDays}人日・{yen(t.partTimerCost)}</td>
                <td data-label="予定個数" style={{ textAlign: 'right' }}>{j.plannedCount}</td>
                <td data-label="実績個数" style={{ textAlign: 'right' }}>{j.actualDays > 0 ? j.actualCount : '—'}</td>
                <td data-label="材料原価" style={{ textAlign: 'right' }}>{yen(t.materialCost)}</td>
                <td data-label="粗利" style={{ textAlign: 'right' }}>{signed(t.billLabor + t.billMaterial - t.partTimerCost - t.materialCost)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
      {(t.extraBilling !== 0 || t.otherCost !== 0) && (
        <p className="hint">会期の粗利 ＝ 日別の計 {signed(t.billLabor + t.billMaterial - t.partTimerCost - t.materialCost)} ＋ 追加の請求 {yen(t.extraBilling)} − その他実費 {yen(t.otherCost)} ＝ <b>{signed(t.gross)}</b></p>
      )}

      {excluded.length > 0 && (
        <div className="panel panel--wide" data-testid="jcos-excluded">
          <div className="panel__title">この計算に入れていない項目（汎用の試算の入力）</div>
          <ul className="plain">
            {excluded.map((x) => <li key={x.label}>{x.label}：{yen(x.amount)}</li>)}
          </ul>
          <div className="panel__hint">
            JCOS 案件では、請求と実費を上の項目だけで計算します（二重に数えないため）。レイアウトの椅子・テーブルなどを増減しても、粗利は変わりません。
            実際に支払うもの（追加のレンタル費・購入費など）があれば、基本情報の「その他実費」に入力してください。入力済みの値は消していないので、収支の計算方法を「汎用」に戻せば、元の試算に戻ります。
          </div>
        </div>
      )}
      {p.reportSync && p.reportSync.venueId !== p.venueId && (
        <p className="hint">※ 日報の同期のあとで会場が変わったため、同期した実績は使っていません。もう一度「日報を同期」を押してください。</p>
      )}
    </div>
  );
}
