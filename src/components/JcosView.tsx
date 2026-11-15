// JCOS 案件の収支（試算シート）。請求（売上）と実費（こちらの支払い）を分けて見せる。
// 計算は domain/jcos.ts。ここは表示と、日ごとの入力（請求する／しない・配置したアルバイトの人数・実績個数の手入力）、
// 内容ごとの材料原価の入力だけ。
import { Estimate } from '../domain/calc';
import { Actual, JcosEstimate, JcosMaterialSummary, Tally, clearNotHeld, jcosExcluded, staffDays, unitCostOf, withJcosDay, withUnitCost } from '../domain/jcos';
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
/** 1 日分の、日報の参加組数・参加人数（未入力は「未入力」と書く。0 とはみなさない） */
function peopleOfDay(a: Actual): string {
  const one = (v: number | undefined, blank: number | undefined, unit: string): string =>
    (v === undefined ? `${unit} 未入力` : `${v} ${unit}${blank ? `（ほか未入力 ${blank} 件）` : ''}`);
  return `${one(a.groups, a.groupsBlank, '組')}・${one(a.people, a.peopleBlank, '人')}`;
}
/** 会期の、日報の参加組数（または参加人数）の合計 */
const tallyText = (t: Tally): string => (t.total == null ? '未入力' : `${t.total}${t.missingDays > 0 ? `（未入力 ${t.missingDays} 日）` : ''}`);

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
    // 「開催なし」の日に実績を入れたら、開催した日として扱う（印を外す。請求する日に戻る。アルバイトは、配置を入れるまで 0 人）
    const entered = n != null && Number.isFinite(n) && n >= 0;
    return { ...x, actualsManual: next, ...(entered && x.jcos ? { jcos: clearNotHeld(x.jcos, [date]) } : {}) };
  });

  const basisText = j.basis === 'actual'
    ? `全 ${j.heldDays} 日の実績（${j.actualCount} 個）で計算${j.periodDays > j.heldDays ? `（開催していない日 ${j.periodDays - j.heldDays} 日を除く）` : ''}`
    : j.basis === 'mixed'
      ? `実績 ${j.actualDays} 日分（${j.actualCount} 個）＋ 残り ${Math.max(0, j.heldDays - j.actualDays)} 日は予定個数で計算`
      : j.periodDays === 0 ? '会期（開始日・終了日）が未入力です' : `予定個数（${j.plannedCount} 個）で計算した見込み。実績はまだありません`;
  const plannedOnly = j.planned.count - j.days.filter((d) => d.actual).reduce((s, d) => s + d.plannedCount, 0);
  // アルバイトを、まだ 1 日も配置していないとき（アルバイト代は、配置した日・人数だけ計上する。自動では計上しない）
  const openDays = j.days.filter((d) => !d.notHeld && d.partTimers === 0).map((d) => d.date);
  // 開催する日があるのに、アルバイトを 1 日も配置していない（＝アルバイト代を 0 円で計算している）。粗利のすぐ下にも、注意を出す
  const noStaffYet = j.partTimerDays === 0 && openDays.length > 0;
  const staffAll = () => onChange((x) => (x.jcos ? { ...x, jcos: staffDays(x.jcos, openDays) } : x));
  // 内容ごとの材料原価（空欄にすると、その内容の指定を外して、案件の標準に戻す）
  const setUnit = (key: string, v: string) => onChange((x) => {
    if (!x.jcos) return x;
    const n = v.trim() === '' ? null : Number(v);
    return { ...x, jcos: withUnitCost(x.jcos, key, n != null && Number.isFinite(n) && n >= 0 ? n : null) };
  });
  // 材料原価の式: どの内容も同じ原価なら「原価 × 個数」、内容ごとに違えば、内訳を見てもらう
  const unit = j.uniformUnitCost;
  const materialFormula = unit == null
    ? '内容ごとの原価 × 個数（下の「材料費」の内訳）'
    : j.basis === 'planned'
      ? `${yen(unit)} × 予定 ${t.count} 個`
      : j.basis === 'actual' ? `${yen(unit)} × 実績 ${t.count} 個` : `${yen(unit)} ×（実績 ${j.actualCount} 個 ＋ 予定 ${plannedOnly} 個）`;
  const countText = (m: JcosMaterialSummary): string => {
    const fmt = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(1));
    if (m.count <= 0) return '—';                  // いまの計算では、個数が無い内容（予定の内容で、どの日にも実績が入っている・原価だけ決めてある）
    if (m.actualCount > 0 && m.plannedCount > 0) return `実績 ${fmt(m.actualCount)} ＋ 予定 ${fmt(m.plannedCount)}`;
    return m.actualCount > 0 ? `実績 ${fmt(m.actualCount)}` : `予定 ${fmt(m.plannedCount)}`;
  };

  const rows: [string, number, string, string][] = [
    ['請求：人件費', t.billLabor, `${yen(terms.billLaborPerDay)} × 請求 ${j.billDays} 日`, ''],
    ['請求：材料費', t.billMaterial, `${yen(terms.billMaterialPerDay)} × 請求 ${j.billDays} 日`, ''],
    ['請求：追加（予備費など）', t.extraBilling, '基本情報の「追加の請求」の合計', ''],
    ['請求 計（売上）', t.billing, '', 'sum'],
    ['実費：アルバイト代', t.partTimerCost, `${yen(terms.partTimerPerDay)} × 配置 ${j.partTimerDays} 人日${j.partTimerDays === 0 ? '（配置した日・人数を、日別の表で入れると計上します）' : ''}`, ''],
    ['実費：材料原価', t.materialCost, materialFormula, ''],
    ['実費：その他', t.otherCost, '基本情報の「その他実費」の合計（入力したものだけ）', ''],
    ['実費 計', t.cost, '', 'sum'],
    ['粗利（管理上）', t.gross, '請求 計 − 実費 計', 'total'],
  ];

  return (
    <div className="est jcos" data-testid="jcos-view" data-basis={j.basis}>
      <div className="cards">
        <div className={`card card--main${t.gross < 0 ? ' card--neg' : ''}`}>
          <div className="card__label">粗利（管理上・試算）</div>
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
      {j.noStaff && (
        <p className="hint jcos__caution" data-testid="jcos-nostaff-top">
          ⚠ アルバイト代は、0 円で計算しています（配置した日・人数が、まだ入っていません）。配置があった場合は、下の「日別」の表で人数を入れると、粗利から引かれます。
          この粗利は、確定した実績ではありません。
        </p>
      )}
      <p className="hint">
        粗利（管理上）＝ JCOS への請求 − 入力してある支払い（アルバイト代・材料原価・その他実費）。日報の実績と、入力した条件から計算した<b>試算</b>です。
        自分たちの稼働の原価や税金は含まない、管理のための数字です（最終的な利益ではありません）。
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
          <span>原価 <b>{yen(t.materialCost)}</b>（{unit == null ? `${t.count} 個・内容ごとの原価` : `${t.count} 個 × ${yen(unit)}`}）</span>
          {t.materialOver > 0
            ? <span className="neg">超過 <b data-testid="jcos-over">{yen(t.materialOver)}</b>（自己負担）</span>
            : <span>請求の範囲内（残り <b data-testid="jcos-over">{yen(t.billMaterial - t.materialCost)}</b>）</span>}
        </div>
        {j.materials.length > 0 && (
          <div className="grid-wrap">
            <table className="grid matgrid" data-testid="jcos-materials">
              <thead><tr><th>内容</th><th>個数</th><th>原価（1 個あたり）</th><th>原価 計</th></tr></thead>
              <tbody>
                {j.materials.map((m) => (
                  <tr key={m.key || ' none'} data-testid="jcos-content" data-key={m.key} data-custom={m.custom ? '1' : '0'}>
                    <td className="is-ro" data-label="内容"><div className="grid__ro">{m.key ? m.label : '内容の指定なし'}</div></td>
                    <td className="is-ro" data-label="個数"><div className="grid__ro num">{countText(m)}</div></td>
                    <td data-label="原価（1 個あたり）">
                      {m.key ? (
                        <NumInput
                          value={m.custom ? String(m.unitCost) : ''} placeholder={`標準 ${unitCostOf(terms, '')}`} style={{ textAlign: 'right' }}
                          aria-label={`${m.label} の材料原価（1 個あたり）`} onValue={(v) => setUnit(m.key, v)}
                        />
                      ) : <div className="grid__ro num">{yen(m.unitCost)}（標準）</div>}
                    </td>
                    <td className="is-ro" data-label="原価 計"><div className="grid__ro num">{yen(m.cost)}</div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="panel__hint">
          {`材料原価は、内容（日報の「イベント内容」・実施コンテンツ）ごとに変えられます。空欄の内容は、この案件の標準（${yen(unitCostOf(terms, ''))}。基本情報の「材料原価」）で計算します。`
            + '標準の初期値 220 円は、フラワーボトルの原価です。'}
        </div>
      </div>

      <div className="panel panel--wide">
        <div className="panel__title">予定と実績</div>
        <div className="matbox__row">
          <span>予定 <b>{j.plannedCount}</b> 個</span>
          <span>実績 <b data-testid="jcos-actual">{j.actualCount}</b> 個（{j.actualDays}／{j.heldDays} 日{j.periodDays > j.heldDays ? `・開催していない日 ${j.periodDays - j.heldDays} 日` : ''}）</span>
          <span>予定だけで計算した粗利 <b className={j.planned.gross < 0 ? 'neg' : ''} data-testid="jcos-planned-gross">{signed(j.planned.gross)}</b></span>
          {j.basis === 'mixed' && <span>実績のある {j.reported.days} 日分の小計 <b className={j.reported.gross < 0 ? 'neg' : ''}>{signed(j.reported.gross)}</b></span>}
        </div>
        {j.participants.reportDays > 0 && (
          <div className="matbox__row" data-testid="jcos-people">
            <span>参加（日報 {j.participants.reportDays} 日分）：組数 <b>{tallyText(j.participants.groups)}</b>・人数 <b>{tallyText(j.participants.people)}</b></span>
          </div>
        )}
        {j.conflicts.length > 0 && (
          <div className="matbox__row neg" data-testid="jcos-conflicts">
            <span>⚠ 手入力の実績と、日報の実績が違う日が {j.conflicts.length} 日あります（計算には日報を使っています。下の表で、手入力の値を消せます）</span>
          </div>
        )}
      </div>

      <h3>日別<small>「請求」のチェックと「アルバイト」の人数は、日ごとに変えられます。アルバイト代は、配置した日・人数だけ計上します（人数を入れていない日は 0 人）。実績個数は、日報の同期で入ります（同期できないときは手入力）。「開催なし」の日は、請求・アルバイト代・予定個数が付きません</small></h3>
      {noStaffYet && (
        <p className="hint" data-testid="jcos-nostaff">
          アルバイトは、どの日にも配置されていません（アルバイト代 0 円）。配置した日があれば、下の表で人数を入れてください。{' '}
          <button className="cellbtn cellbtn--wide" onClick={staffAll} data-testid="jcos-staff-all">開催する {openDays.length} 日すべてに 1 人ずつ入れる</button>
        </p>
      )}
      {j.days.length === 0 ? <p className="hint">基本情報で会期（開始日・終了日）を入力すると、日別の表が表示されます。</p> : (
        <div className="grid-wrap">
          <table className="grid daygrid" data-testid="jcos-days">
            <thead>
              <tr><th>日付</th><th>請求</th><th>アルバイト</th><th>予定個数</th><th>実績個数</th><th>材料原価</th><th>粗利</th></tr>
            </thead>
            <tbody>
              {j.days.map((d) => (
                <tr key={d.date} data-testid={`jcos-day-${d.date}`} data-basis={d.basis} data-held={d.notHeld ? '0' : '1'}>
                  <td className="is-ro daygrid__date" data-label="日付">
                    <div className="grid__ro">{shortDate(d.date)}{d.notHeld && <small className="tag" title="日報に回答の無い日です。請求する・アルバイトの人数を入れると、開催した日として扱います">開催なし</small>}</div>
                  </td>
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
                        <small className="daygrid__note" data-testid="jcos-day-people">{peopleOfDay(d.actual)}</small>
                        {d.manualIgnored != null && (
                          <small className="daygrid__note neg">
                            手入力 {d.manualIgnored} は使っていません{' '}
                            <button className="cellbtn" onClick={() => setManual(d.date, '')} aria-label={`${shortDate(d.date)} の手入力の実績を消す`} data-testid="jcos-clear-manual">手入力を消す</button>
                          </small>
                        )}
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
                    <div className={`grid__ro num${d.gross < 0 ? ' neg' : ''}`}><b>{signed(d.gross)}</b> {!d.notHeld && <small className={`tag${d.basis === 'actual' ? ' tag--on' : ''}`}>{d.basis === 'actual' ? '実績' : '予定'}</small>}</div>
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
