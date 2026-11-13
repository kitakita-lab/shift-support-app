// 日報の取得（sheets.ts）のテスト。Google への通信は、応答を差し替えて確かめる（実際の Google にはつながない）。
import { describe, expect, it } from 'vitest';
import { HttpGet, ReportError, SHEETS_API, fetchReportRows, pickSheet, toReportError } from './sheets';

const ID = 'sheet-id-0123456789abcdefghij';
const HEADER = ['タイムスタンプ', 'メールアドレス', '入力者', '開催日', '天気', '会場', '会場（その他の場合）', 'イベント名', 'イベント内容', '参加組数', '参加人数', 'キットの使用数', '内部用メモ'];
const TAB = 'フォームの回答 1';

interface Call { url: string; auth: string }
/** 差し替えの通信。URL に応じて応答を返し、呼ばれた URL を記録する */
function fake(routes: (url: URL) => { status?: number; body: unknown } | 'throw'): { http: HttpGet; calls: Call[] } {
  const calls: Call[] = [];
  const http: HttpGet = async (url, init) => {
    calls.push({ url, auth: init.headers.Authorization });
    const r = routes(new URL(url));
    if (r === 'throw') throw new TypeError('Failed to fetch');
    const status = r.status ?? 200;
    return { ok: status >= 200 && status < 300, status, json: async () => r.body };
  };
  return { http, calls };
}
/** 正常な日報。columns は「列の文字 → 2 行目以降の値」 */
function sheet(columns: Record<string, unknown[]>, opts: { header?: unknown[]; tabs?: { sheetId: number; title: string }[] } = {}) {
  return fake((u) => {
    if (u.pathname.endsWith(':batchGet')) {
      return { body: { valueRanges: u.searchParams.getAll('ranges').map((range) => {
        const col = /!([A-Z]+)2:/.exec(range)![1];
        return columns[col]?.length ? { range, majorDimension: 'COLUMNS', values: [columns[col]] } : { range, majorDimension: 'COLUMNS' };
      }) } };
    }
    if (u.pathname.includes('/values/')) return { body: { values: [opts.header ?? HEADER] } };
    return { body: { sheets: (opts.tabs ?? [{ sheetId: 1622532141, title: TAB }]).map((properties) => ({ properties })) } };
  });
}
const err = async (p: Promise<unknown>): Promise<ReportError> => {
  try { await p; } catch (e) { if (e instanceof ReportError) return e; throw e; }
  throw new Error('エラーになりませんでした');
};

describe('日報の取得: 必要な列だけを読む', () => {
  it('3 回の問い合わせ（タブの一覧 → 見出し行 → 必要な列）で、回答を行にそろえて返す', async () => {
    const { http, calls } = sheet({
      D: [46339, 46340, 46340], F: ['北街モール', 'その他', '北街モール'], G: ['', 'みなと市場'], H: ['秋の花まつり'], L: [62, 21, 58],
    });
    const rows = await fetchReportRows({ spreadsheetId: ID, gid: null }, 'tok-1', http);
    expect(rows).toEqual([
      { date: 46339, venue: '北街モール', venueOther: '', event: '秋の花まつり', count: 62 },
      { date: 46340, venue: 'その他', venueOther: 'みなと市場', event: '', count: 21 },
      { date: 46340, venue: '北街モール', venueOther: '', event: '', count: 58 },
    ]);
    expect(calls.length).toBe(3);
    expect(calls.every((c) => c.auth === 'Bearer tok-1')).toBe(true);
    expect(calls.every((c) => c.url.startsWith(`${SHEETS_API}/${ID}`))).toBe(true);
  });

  it('要求するのは、見出し行（1 行目）と D・F・G・H・L の 2 行目以降だけ。メールアドレス・入力者・内部用メモの列は要求しない', async () => {
    const { http, calls } = sheet({ D: [46339], F: ['北街モール'], L: [1] });
    await fetchReportRows({ spreadsheetId: ID }, 'tok', http);
    const meta = new URL(calls[0].url);
    expect(meta.searchParams.get('fields')).toBe('sheets.properties(sheetId,title)');   // タブの名前と ID だけ（セルの中身は含まない）
    expect(decodeURIComponent(new URL(calls[1].url).pathname)).toBe(`/v4/spreadsheets/${ID}/values/'${TAB}'!1:1`);
    const data = new URL(calls[2].url);
    expect(data.searchParams.getAll('ranges')).toEqual(['D', 'F', 'G', 'H', 'L'].map((c) => `'${TAB}'!${c}2:${c}`));
    expect(data.searchParams.get('majorDimension')).toBe('COLUMNS');
    expect(data.searchParams.get('valueRenderOption')).toBe('UNFORMATTED_VALUE');
    expect(data.searchParams.get('dateTimeRenderOption')).toBe('SERIAL_NUMBER');
    // 読み取り以外の操作は無い（差し替えの通信は GET だけを受け付ける形なので、URL に書き込み用の操作が無いことを確かめる）
    expect(calls.some((c) => /:append|:clear|:batchUpdate|values:batchClear/.test(c.url))).toBe(false);
  });

  it('列の位置がずれた日報では、見出しの名前で見つけた列を要求する', async () => {
    const header = ['タイムスタンプ', 'メールアドレス', '入力者', '新しい質問', ...HEADER.slice(3)];
    const { http, calls } = sheet({ E: [46339], G: ['北街モール'], M: [62] }, { header });
    const rows = await fetchReportRows({ spreadsheetId: ID }, 'tok', http);
    expect(new URL(calls[2].url).searchParams.getAll('ranges')).toEqual(['E', 'G', 'H', 'I', 'M'].map((c) => `'${TAB}'!${c}2:${c}`));
    expect(rows).toEqual([{ date: 46339, venue: '北街モール', venueOther: '', event: '', count: 62 }]);
  });

  it('見出しに必要な列が無ければ、データの列を読まずにエラーにする', async () => {
    const { http, calls } = sheet({ D: [46339] }, { header: ['開催日', '会場', '参加人数'] });
    const e = await err(fetchReportRows({ spreadsheetId: ID }, 'tok', http));
    expect(e.code).toBe('bad-header');
    expect(e.message).toContain('「キットの使用数」');
    expect(calls.length).toBe(2);                       // 3 回目（データの列）は呼んでいない
  });

  it('回答が 1 件も無い日報は、空の一覧を返す', async () => {
    const { http } = sheet({});
    expect(await fetchReportRows({ spreadsheetId: ID }, 'tok', http)).toEqual([]);
  });

  it('途中に空欄がある列・末尾が省かれた列も、行がずれない', async () => {
    const { http } = sheet({ D: [46339, '', 46341], F: ['A', '', 'C'], L: [1, '', 3] });
    const rows = await fetchReportRows({ spreadsheetId: ID }, 'tok', http);
    expect(rows.map((r) => [r.date, r.venue, r.count])).toEqual([[46339, 'A', 1], ['', '', ''], [46341, 'C', 3]]);
  });
});

describe('日報のタブの選び方', () => {
  const tabs = [{ sheetId: 0, title: '集計' }, { sheetId: 1622532141, title: TAB }, { sheetId: 5, title: 'メモ' }];
  it('URL でタブが指定されていれば、そのタブ', () => {
    expect(pickSheet(tabs, { spreadsheetId: ID, gid: 5 })).toBe('メモ');
    expect(pickSheet(tabs, { spreadsheetId: ID, gid: 0 })).toBe('集計');
  });
  it('指定が無い・指定のタブが無いときは、「フォームの回答 1」', () => {
    expect(pickSheet(tabs, { spreadsheetId: ID })).toBe(TAB);
    expect(pickSheet(tabs, { spreadsheetId: ID, gid: 999 })).toBe(TAB);
    expect(pickSheet([{ sheetId: 1, title: 'フォームの回答　１' }], { spreadsheetId: ID })).toBe('フォームの回答　１');
  });
  it('どちらも無いときは、タブが 1 つだけならそれ。複数あれば決めない', () => {
    expect(pickSheet([{ sheetId: 3, title: '日報' }], { spreadsheetId: ID })).toBe('日報');
    expect(pickSheet([{ sheetId: 3, title: '日報' }, { sheetId: 4, title: '集計' }], { spreadsheetId: ID })).toBeNull();
    expect(pickSheet([], { spreadsheetId: ID })).toBeNull();
  });
  it('タブ名に「\'」が入っていても、範囲の指定が壊れない', async () => {
    const { http, calls } = sheet({ D: [46339], F: ['A'], L: [1] }, { tabs: [{ sheetId: 1, title: "it's" }] });
    await fetchReportRows({ spreadsheetId: ID }, 'tok', http);
    expect(new URL(calls[2].url).searchParams.getAll('ranges')[0]).toBe("'it''s'!D2:D");
  });
  it('タブを決められないときはエラー', async () => {
    const { http } = sheet({}, { tabs: [{ sheetId: 3, title: '日報' }, { sheetId: 4, title: '集計' }] });
    expect((await err(fetchReportRows({ spreadsheetId: ID }, 'tok', http))).code).toBe('no-sheet');
  });
});

describe('エラーの伝え方', () => {
  const at = (status: number, body: unknown = {}) => toReportError(status, body).code;
  it('状態コードと理由から、原因ごとのエラーにする', () => {
    expect(at(401)).toBe('auth-expired');
    expect(at(403, { error: { status: 'PERMISSION_DENIED', message: 'The caller does not have permission' } })).toBe('no-access');
    expect(at(403, { error: { message: 'Google Sheets API has not been used in project 123 before or it is disabled.', details: [{ reason: 'SERVICE_DISABLED' }] } })).toBe('api-disabled');
    expect(at(403, { error: { message: 'Google Sheets API has not been used in project 123 before or it is disabled.' } })).toBe('api-disabled');
    expect(at(403, { error: { message: 'Request had insufficient authentication scopes.', details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }] } })).toBe('no-scope');
    expect(at(404)).toBe('not-found');
    expect(at(429)).toBe('rate');
    expect(at(400, { error: { message: "Unable to parse range: 'x'!1:1" } })).toBe('no-sheet');
    expect(at(500)).toBe('server');
    expect(at(503)).toBe('server');
    expect(at(418)).toBe('unknown');
    expect(at(403, null)).toBe('no-access');
  });
  it('通信できないときは、通信エラー', async () => {
    const { http } = fake(() => 'throw');
    expect((await err(fetchReportRows({ spreadsheetId: ID }, 'tok', http))).code).toBe('network');
  });
  it('どの段階のエラーでも、そこで止まる（あとの問い合わせをしない）', async () => {
    for (const failAt of [0, 1, 2]) {
      let n = 0;
      const { http, calls } = fake((u) => {
        const i = n; n += 1;
        if (i === failAt) return { status: 403, body: { error: { message: 'The caller does not have permission' } } };
        if (u.pathname.includes('/values/')) return { body: { values: [HEADER] } };
        return { body: { sheets: [{ properties: { sheetId: 1, title: TAB } }] } };
      });
      expect((await err(fetchReportRows({ spreadsheetId: ID }, 'tok', http))).code).toBe('no-access');
      expect(calls.length).toBe(failAt + 1);
    }
  });
  it('応答の列の数が要求と合わなければ、取り込まない', async () => {
    const { http } = fake((u) => {
      if (u.pathname.endsWith(':batchGet')) return { body: { valueRanges: [{ values: [[1]] }] } };
      if (u.pathname.includes('/values/')) return { body: { values: [HEADER] } };
      return { body: { sheets: [{ properties: { sheetId: 1, title: TAB } }] } };
    });
    expect((await err(fetchReportRows({ spreadsheetId: ID }, 'tok', http))).code).toBe('unknown');
  });
});
