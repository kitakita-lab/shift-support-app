// 配置図の版数（V1, V2…）。設計書 3.4／作業ログ D-07：
//   「PDF を出力した版に手を入れた時点で自動的に次の版になる」「出力せずに編集している間は上がらない」
// 守りたいこと：同じ版番号で内容の違う図が 2 種類できないこと（配った図と版数が 1 対 1）。
import { describe, expect, it } from 'vitest';
import { Layout } from '../types';
import {
  addPart, applyTemplate, bumpIfIssued, emptyLayout, isIssued, layoutTitle, markIssued, nextVersion, undoTo, updateItem,
} from './layout';
import { defaultPartTypes, duplicateProject, sampleData, sampleTemplate } from './seed';
import { projectWarnings } from './warnings';

const parts = defaultPartTypes();
const chair = parts.find((p) => p.id === 'pt-chair')!;

/** LayoutEditor と同じ手順を純関数だけで再現する（編集＝commit、出力＝markIssued、元に戻す＝undoTo） */
function session(start: Layout = emptyLayout()) {
  let layout = start;
  const history: Layout[] = [];
  const pdfs: { version: number; content: string }[] = [];
  const content = (l: Layout) => JSON.stringify({ env: l.env, items: l.items.map(({ id: _id, ...i }) => i), caption: l.caption, notes: l.notes });
  return {
    get layout() { return layout; },
    get pdfs() { return pdfs; },
    edit(fn: (l: Layout) => Layout = (l) => addPart(l, chair)) {
      const next = fn(layout);
      history.push(layout);
      layout = bumpIfIssued(next);
    },
    exportPdf(date = '2026-11-13') {
      pdfs.push({ version: layout.version, content: content(layout) });
      layout = markIssued(layout, date);
    },
    undo() {
      const prev = history.pop();
      if (prev) layout = undoTo(layout, prev);
    },
    /** 出力した PDF のうち、同じ版番号で内容が違うものの版番号 */
    conflicts() {
      const seen = new Map<number, string>();
      const bad = new Set<number>();
      for (const p of pdfs) {
        if (seen.has(p.version) && seen.get(p.version) !== p.content) bad.add(p.version);
        seen.set(p.version, p.content);
      }
      return [...bad];
    },
  };
}

describe('版数の基本（設計書 3.4）', () => {
  it('新規は V1・未出力。出力するまでは何度編集しても V1', () => {
    const s = session();
    expect([s.layout.version, isIssued(s.layout)]).toEqual([1, false]);
    for (let i = 0; i < 5; i++) s.edit();
    expect([s.layout.version, isIssued(s.layout), s.layout.issued]).toEqual([1, false, []]);
  });
  it('出力するとその版が「出力済み」になり、版と日付が履歴に残る。出力しただけでは版は上がらない', () => {
    const s = session();
    s.exportPdf('2026-11-13');
    expect([s.layout.version, isIssued(s.layout)]).toEqual([1, true]);
    expect(s.layout.issued).toEqual([{ version: 1, issuedAt: '2026-11-13' }]);
  });
  it('同じ内容の再出力では版は上がらず、履歴も増えない', () => {
    const s = session();
    s.exportPdf('2026-11-13');
    const before = s.layout;
    s.exportPdf('2026-11-14');
    expect(s.layout).toBe(before);
    expect(s.conflicts()).toEqual([]);
  });
  it('出力済みの版を編集した時点で V2 になる。V2 を出力するまでは編集を重ねても V2 のまま', () => {
    const s = session();
    s.exportPdf();
    s.edit();
    expect([s.layout.version, isIssued(s.layout)]).toEqual([2, false]);
    s.edit(); s.edit();
    expect(s.layout.version).toBe(2);
    expect(s.layout.issued.map((v) => v.version)).toEqual([1]);
  });
  it('V1 出力 → 編集 → V2 出力 → 編集 → V3。履歴は V1・V2', () => {
    const s = session();
    s.exportPdf('2026-11-11'); s.edit();
    s.exportPdf('2026-11-12'); s.edit();
    expect(s.layout.version).toBe(3);
    expect(s.layout.issued).toEqual([{ version: 1, issuedAt: '2026-11-11' }, { version: 2, issuedAt: '2026-11-12' }]);
    expect(s.conflicts()).toEqual([]);
  });
  it('パーツの増減だけでなく、表示名・注記・未確認事項の変更も「編集」として版が上がる', () => {
    for (const fn of [
      (l: Layout) => ({ ...l, notes: '電源の位置' }),
      (l: Layout) => ({ ...l, caption: '確定版' }),
      (l: Layout) => updateItem(l, l.items[0].id, { label: '受付' }),
    ]) {
      const s = session(addPart(emptyLayout(), chair));
      s.exportPdf();
      s.edit(fn);
      expect(s.layout.version).toBe(2);
    }
  });
  it('図面タイトルに版数が入る', () => {
    expect(layoutTitle('ikyu', 'ラソラ札幌', 1)).toBe('ikyu｜ラソラ札幌 イベント配置図 V1');
    expect(layoutTitle('ikyu', 'ラソラ札幌', 12)).toBe('ikyu｜ラソラ札幌 イベント配置図 V12');
    expect(layoutTitle('', 'ラソラ札幌', 2)).toBe('ラソラ札幌 イベント配置図 V2');
    expect(layoutTitle('ikyu', '', 2)).toBe('ikyu イベント配置図 V2');
  });
});

describe('「元に戻す」と版数', () => {
  it('出力後に編集して元に戻す → 出力した内容そのものに戻るので V1（出力済み）に戻る', () => {
    const s = session();
    s.edit(); s.exportPdf(); s.edit();
    expect(s.layout.version).toBe(2);
    s.undo();
    expect([s.layout.version, isIssued(s.layout)]).toEqual([1, true]);
    s.exportPdf();
    expect(s.conflicts()).toEqual([]);
  });
  it('出力より前の状態まで元に戻しても、出力の記録は消えない', () => {
    const s = session();
    s.edit();                 // 椅子 1
    s.exportPdf('2026-11-13');// V1 を出力（椅子 1）
    s.undo();                 // 椅子 0 に戻す
    expect(s.layout.items).toHaveLength(0);
    expect(s.layout.issued).toEqual([{ version: 1, issuedAt: '2026-11-13' }]);
  });
  it('出力より前の状態まで元に戻したら、出力済みの V1 とは内容が違うので V2 になる', () => {
    const s = session();
    s.edit(); s.exportPdf(); s.undo();
    expect([s.layout.version, isIssued(s.layout)]).toEqual([2, false]);
    s.exportPdf();            // この内容を出力しても「V1」が 2 種類にはならない
    expect(s.pdfs.map((p) => p.version)).toEqual([1, 2]);
    expect(s.conflicts()).toEqual([]);
  });
  it('V2 を出力したあと V1 の状態まで元に戻して編集しても、出力済みの V2 と同じ番号にはならない', () => {
    const s = session();
    s.exportPdf();            // V1
    s.edit();                 // → V2（椅子 1）
    s.exportPdf();            // V2 を出力
    s.undo();                 // V1 の内容へ
    expect([s.layout.version, isIssued(s.layout)]).toEqual([1, true]);
    expect(s.layout.issued.map((v) => v.version)).toEqual([1, 2]);   // V2 の記録は残る
    s.edit((l) => addPart(addPart(l, chair), chair));               // 別の内容に編集
    expect(s.layout.version).toBe(3);                               // V2 ではなく V3
    s.exportPdf();
    expect(s.conflicts()).toEqual([]);
  });
  it('出力していない作業中の版の中で元に戻しても、版は変わらない', () => {
    const s = session();
    s.exportPdf(); s.edit(); s.edit(); s.edit();
    expect(s.layout.version).toBe(2);
    s.undo(); s.undo();
    expect([s.layout.version, isIssued(s.layout), s.layout.items.length]).toEqual([2, false, 1]);
  });
  it('どんな順番で 編集・出力・元に戻す を繰り返しても、同じ版番号で内容の違う PDF は出ない', () => {
    // 3 種類の操作のあらゆる並び（長さ 9 まで）を総当たり
    const ops = ['edit', 'export', 'undo'] as const;
    let checked = 0;
    const walk = (seq: number[]) => {
      if (seq.length > 0) {
        const s = session();
        let n = 0;
        for (const o of seq) {
          if (ops[o] === 'edit') { n += 1; const k = n; s.edit((l) => ({ ...l, notes: `edit-${k}` })); }
          else if (ops[o] === 'export') s.exportPdf();
          else s.undo();
        }
        s.exportPdf();
        expect(s.conflicts(), seq.map((o) => ops[o]).join('→')).toEqual([]);
        // 作業中の版番号は、出力済みのどの版とも「同じ番号で違う内容」にならない
        checked += 1;
      }
      if (seq.length < 9) for (let o = 0; o < 3; o++) walk([...seq, o]);
    };
    walk([]);
    expect(checked).toBe(3 + 9 + 27 + 81 + 243 + 729 + 2187 + 6561 + 19683);
  });
});

describe('版番号の採番', () => {
  it('次の版番号は「作業中の版・出力済みの版のどれよりも大きい番号」', () => {
    expect(nextVersion(emptyLayout())).toBe(2);
    expect(nextVersion({ ...emptyLayout(), version: 3, issued: [{ version: 1, issuedAt: 'x' }, { version: 2, issuedAt: 'x' }] })).toBe(4);
    // V1 の状態に戻っているが V2 まで出力済み → 次は V3
    expect(nextVersion({ ...emptyLayout(), version: 1, issued: [{ version: 1, issuedAt: 'x' }, { version: 2, issuedAt: 'x' }] })).toBe(3);
  });
  it('出力済みの版を編集したときの繰り上げ先は、出力済みの番号を飛び越える', () => {
    const l = { ...emptyLayout(), version: 1, issued: [{ version: 1, issuedAt: 'x' }, { version: 2, issuedAt: 'x' }] };
    expect(bumpIfIssued(l).version).toBe(3);
  });
});

describe('エディタ以外から図が変わる操作', () => {
  const tpl = sampleTemplate();

  it('会場変更・雛形の読み直しで周辺環境を置き換えると、出力済みの版は次の版になる', () => {
    let l = addPart(emptyLayout(), chair);
    l = markIssued(l, '2026-11-13');
    const out = applyTemplate(l, tpl);
    expect(out.version).toBe(2);
    expect(out.issued).toEqual([{ version: 1, issuedAt: '2026-11-13' }]);
    expect(out.env).toHaveLength(tpl.env.length);
    expect([out.width, out.height]).toEqual([tpl.width, tpl.height]);
  });
  it('未出力の版なら、周辺環境を置き換えても版は上がらない', () => {
    expect(applyTemplate(addPart(emptyLayout(), chair), tpl).version).toBe(1);
  });
  it('置き換えても配置済みパーツ・表示名・注記は残る。雛形側は書き換わらない', () => {
    let l = addPart(emptyLayout(), chair);
    l = { ...updateItem(l, l.items[0].id, { label: '講師席' }), notes: '電源の位置', caption: '仮' };
    const snapshot = structuredClone(tpl);
    const out = applyTemplate(l, tpl);
    expect(out.items).toEqual(l.items);
    expect([out.notes, out.caption]).toEqual(['電源の位置', '仮']);
    out.env[0].label = '書き換え';
    expect(tpl).toEqual(snapshot);
    expect(out.env.some((e) => tpl.env.some((t) => t.id === e.id))).toBe(false);
  });
});

describe('案件の複製', () => {
  it('複製は新しい案件として V1・未出力から始まる（元の案件の版と出力履歴は変わらない）', () => {
    const src = sampleData().projects[0];
    const issued = { ...src, layout: bumpIfIssued(markIssued(src.layout, '2026-11-13')) };   // V1 出力済み → 編集して V2
    const withEdit = { ...issued, layout: { ...issued.layout, version: 2 } };
    const copy = duplicateProject(withEdit);
    expect([copy.layout.version, copy.layout.issued]).toEqual([1, []]);
    expect(copy.id).not.toBe(src.id);
    expect(copy.name).toBe(`${src.name}（コピー）`);
    expect(copy.status).toBe('計画中');
    expect(withEdit.layout.version).toBe(2);
    expect(withEdit.layout.issued).toHaveLength(1);
  });
  it('複製した側を編集しても元の案件は変わらない（中身は別物としてコピーされる）', () => {
    const src = sampleData().projects[0];
    const snapshot = structuredClone(src);
    const copy = duplicateProject(src);
    copy.layout.items.pop();
    copy.contents[0].plannedCount = 1;
    copy.assignments.length = 0;
    expect(src).toEqual(snapshot);
  });
  it('スタッフ配置は引き継がない。コンテンツ・費用・レイアウトは複製される（作業ログ D-19）', () => {
    const src = sampleData().projects[0];
    const copy = duplicateProject(src);
    expect(src.assignments.length).toBeGreaterThan(0);
    expect(copy.assignments).toEqual([]);
    expect(copy.contents).toEqual(src.contents);
    expect(copy.otherCosts).toEqual(src.otherCosts);
    expect([copy.fixedRevenue, copy.venueFeeFixed, copy.venueFeePerDay, copy.venueFeeRatePct]).toEqual([src.fixedRevenue, src.venueFeeFixed, src.venueFeePerDay, src.venueFeeRatePct]);
    expect(copy.layout.items).toEqual(src.layout.items);
    expect(copy.layout.env).toEqual(src.layout.env);
    expect([copy.venueId, copy.startDate, copy.endDate]).toEqual([src.venueId, src.startDate, src.endDate]);
  });
  it('複製した直後は、元の案件にも複製にも掛け持ちの警告が出ない（配置が無いので重ならない）。複製には「誰も配置されていない日」の参考表示が日数分出る', () => {
    const d = sampleData();
    const src = d.projects[1];
    const copy = duplicateProject(src);
    const data = { ...d, projects: [...d.projects, copy] };
    const double = (p: typeof src) => projectWarnings(p, data).filter((w) => w.message.includes('別案件'));
    expect(double(src)).toEqual([]);
    expect(double(copy)).toEqual([]);
    expect(projectWarnings(copy, data).filter((w) => w.target.startsWith('day:'))).toHaveLength(5);
  });
});
