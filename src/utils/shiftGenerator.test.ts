import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { Staff, WorkSite } from '../types';
import { generateShifts } from './shiftGenerator';

// ─────────────────────────────────────────────────────────────
// generateShifts の characterization テスト（現在の挙動を「正」として固定）。
//
// sessionPriority・スタッフ制約UI・スコアリング改善の実装前に、
// 変更が「どこを変えたか」を機械的に検出できるようにするのが目的。
// 期待値はすべて現在のアルゴリズム（HARD CONSTRAINT → スコアソート →
// 貪欲選出）をコードから読み取って導出している。
//
// 【重要】「同日重複勤務は現在禁止されていない」等、仕様として疑わしい
// 挙動もそのまま固定している。該当テストのコメントを参照。
// ─────────────────────────────────────────────────────────────

// 2026-06-01 は月曜。以降 6/2(火) 6/3(水) 6/4(木) 6/5(金) 6/6(土) 6/7(日)
const MON = '2026-06-01';
const TUE = '2026-06-02';
const WED = '2026-06-03';
const THU = '2026-06-04';

function makeStaff(overrides: Partial<Staff> & { id: string }): Staff {
  return {
    staffNo: '',
    name: overrides.id,
    availableWeekdays: [],
    requestedDaysOff: [],
    maxWorkDays: 20,
    maxConsecutiveDays: 5,
    memo: '',
    preferredWorkSites: [],
    ngPartnerIds: [],
    ...overrides,
  };
}

function makeSite(overrides: Partial<WorkSite> & { id: string; date: string }): WorkSite {
  return {
    siteName: `現場${overrides.id}`,
    startTime: '09:00',
    endTime: '18:00',
    requiredPeople: 1,
    memo: '',
    ...overrides,
  };
}

// DEV モードのデバッグ console.log を抑制
beforeAll(() => { vi.spyOn(console, 'log').mockImplementation(() => {}); });
afterAll(() => { vi.restoreAllMocks(); });

describe('generateShifts: 正常系', () => {
  it('スタッフ・現場が十分なら全現場に必要人数が配置される', () => {
    const staff = [
      makeStaff({ id: 'A', staffNo: '1' }),
      makeStaff({ id: 'B', staffNo: '2' }),
      makeStaff({ id: 'C', staffNo: '3' }),
    ];
    const sites = [
      makeSite({ id: 's1', date: MON, requiredPeople: 2 }),
      makeSite({ id: 's2', date: TUE, requiredPeople: 2 }),
    ];
    const result = generateShifts(staff, sites);
    expect(result).toHaveLength(2);
    expect(result[0].assignedStaffIds).toHaveLength(2);
    expect(result[1].assignedStaffIds).toHaveLength(2);
    expect(result[0].shortage).toBe(0);
    expect(result[1].shortage).toBe(0);
  });

  it('出力は日付昇順で、assignedStaffIds は staffNo 順にソートされる', () => {
    const staff = [
      makeStaff({ id: 'B', staffNo: '2' }),
      makeStaff({ id: 'A', staffNo: '1' }),
    ];
    // 入力順は日付逆順 → 出力は日付昇順に並び替えられる
    const sites = [
      makeSite({ id: 'later',   date: TUE, requiredPeople: 2 }),
      makeSite({ id: 'earlier', date: MON, requiredPeople: 2 }),
    ];
    const result = generateShifts(staff, sites);
    expect(result.map((r) => r.siteId)).toEqual(['earlier', 'later']);
    // 入力順（B,A）ではなく staffNo 順（A=1, B=2）
    expect(result[0].assignedStaffIds).toEqual(['A', 'B']);
  });

  it('isPlaceholder の現場は出力に含まれない', () => {
    const staff = [makeStaff({ id: 'A' })];
    const sites = [
      makeSite({ id: 'real', date: MON }),
      makeSite({ id: 'ph',   date: TUE, isPlaceholder: true }),
    ];
    const result = generateShifts(staff, sites);
    expect(result.map((r) => r.siteId)).toEqual(['real']);
  });

  it('現場ゼロなら空配列、スタッフゼロなら全現場 shortage', () => {
    expect(generateShifts([makeStaff({ id: 'A' })], [])).toEqual([]);
    const result = generateShifts([], [makeSite({ id: 's1', date: MON, requiredPeople: 3 })]);
    expect(result).toEqual([{ siteId: 's1', assignedStaffIds: [], shortage: 3 }]);
  });
});

describe('generateShifts: HARD CONSTRAINT', () => {
  it('希望休の日には配置されない', () => {
    const staff = [
      makeStaff({ id: 'A', staffNo: '1', requestedDaysOff: [MON] }),
      makeStaff({ id: 'B', staffNo: '2' }),
    ];
    const result = generateShifts(staff, [makeSite({ id: 's1', date: MON })]);
    expect(result[0].assignedStaffIds).toEqual(['B']);
  });

  it('勤務不可曜日には配置されない（availableWeekdays 非空の場合のみ制限）', () => {
    const staff = [
      makeStaff({ id: 'A', staffNo: '1', availableWeekdays: ['火'] }), // 月曜不可
      makeStaff({ id: 'B', staffNo: '2', availableWeekdays: [] }),     // 空 = 全曜日可
    ];
    const monday = generateShifts(staff, [makeSite({ id: 'mon', date: MON })]);
    expect(monday[0].assignedStaffIds).toEqual(['B']);

    const tuesday = generateShifts(staff, [makeSite({ id: 'tue', date: TUE })]);
    // 火曜は両者可。workDays 同点 → staffNo 順で A
    expect(tuesday[0].assignedStaffIds).toEqual(['A']);
  });

  it('月間最大勤務日数（ユニーク日数）に達すると以降配置されない', () => {
    const staff = [
      makeStaff({ id: 'A', staffNo: '1', maxWorkDays: 1 }),
      makeStaff({ id: 'B', staffNo: '2' }),
    ];
    const sites = [
      makeSite({ id: 'd1', date: MON }),
      makeSite({ id: 'd2', date: TUE }),
    ];
    const result = generateShifts(staff, sites);
    expect(result[0].assignedStaffIds).toEqual(['A']); // 1日目: staffNo 順で A
    expect(result[1].assignedStaffIds).toEqual(['B']); // 2日目: A は上限到達
  });

  it('最大連勤を超える配置はされない（前方連続）', () => {
    const staff = [
      makeStaff({ id: 'A', staffNo: '1', maxConsecutiveDays: 2 }),
      makeStaff({ id: 'B', staffNo: '2' }),
    ];
    const sites = [
      makeSite({ id: 'd1', date: MON }),
      makeSite({ id: 'd2', date: TUE }),
      makeSite({ id: 'd3', date: WED }),
    ];
    const result = generateShifts(staff, sites);
    // A: 月火と連勤（workDays が B と同点→staffNo 順、1日目 A、2日目は workDays 少ない B…
    // ではなく、2日目時点 A=1日 B=0日 → B 優先。3日目 A=1 B=1 → 同点で A。
    // よって実際の配置は 月=A, 火=B, 水=A（連勤上限には達しない）
    expect(result.map((r) => r.assignedStaffIds)).toEqual([['A'], ['B'], ['A']]);
  });

  it('最大連勤: 挟み込み（前後の既存連勤 + 当日）も数える', () => {
    // A のみ・3現場。maxConsecutiveDays=2 の場合:
    // 月: 配置(1連勤) → 火: 月+火=2連勤 OK → 水: 火+水… 月火水=3連勤 > 2 → 拒否
    const staff = [makeStaff({ id: 'A', maxConsecutiveDays: 2 })];
    const sites = [
      makeSite({ id: 'd1', date: MON }),
      makeSite({ id: 'd2', date: TUE }),
      makeSite({ id: 'd3', date: WED }),
      makeSite({ id: 'd4', date: THU }),
    ];
    const result = generateShifts(staff, sites);
    expect(result.map((r) => r.assignedStaffIds)).toEqual([['A'], ['A'], [], ['A']]);
    expect(result[2].shortage).toBe(1); // 水曜は3連勤になるため配置不可
  });

  it('NGペア: 相手が先に配置されていたらスキップされ次点が入る', () => {
    const staff = [
      makeStaff({ id: 'A', staffNo: '1' }),
      makeStaff({ id: 'B', staffNo: '2', ngPartnerIds: ['A'] }),
      makeStaff({ id: 'C', staffNo: '3' }),
    ];
    const result = generateShifts(staff, [makeSite({ id: 's1', date: MON, requiredPeople: 2 })]);
    // スコア順 A→B→C。A 配置後、B は ngPartnerIds に A を含むためスキップ → C
    expect(result[0].assignedStaffIds).toEqual(['A', 'C']);
  });

  it('候補が必要人数に満たない場合 shortage が計上される', () => {
    const staff = [
      makeStaff({ id: 'A', staffNo: '1' }),
      makeStaff({ id: 'B', staffNo: '2', requestedDaysOff: [MON] }),
    ];
    const result = generateShifts(staff, [makeSite({ id: 's1', date: MON, requiredPeople: 3 })]);
    expect(result[0].assignedStaffIds).toEqual(['A']);
    expect(result[0].shortage).toBe(2);
  });

  it('【現状固定】同日の複数現場への重複配置は現在禁止されていない', () => {
    // passesHardConstraints に「同日既配置」チェックは存在しない。
    // 同日2現場目でもユニーク日数(Set)が増えないため全チェックを通過する。
    // これは仕様として疑わしいが、本テストは現状を固定するのが目的。
    // 同日重複禁止を実装する際は、このテストを意図的に更新すること。
    const staff = [makeStaff({ id: 'A' })];
    const sites = [
      makeSite({ id: 'am', date: MON, startTime: '09:00', endTime: '13:00' }),
      makeSite({ id: 'pm', date: MON, startTime: '14:00', endTime: '18:00' }),
    ];
    const result = generateShifts(staff, sites);
    expect(result[0].assignedStaffIds).toEqual(['A']);
    expect(result[1].assignedStaffIds).toEqual(['A']); // 同日2現場目にも配置される
  });
});

describe('generateShifts: SOFT SCORE', () => {
  it('優先現場（preferredWorkSites が siteName と完全一致）のスタッフが優先される', () => {
    const staff = [
      makeStaff({ id: 'A', staffNo: '1' }),
      makeStaff({ id: 'B', staffNo: '2', preferredWorkSites: ['WB小樽'] }),
    ];
    const result = generateShifts(staff, [
      makeSite({ id: 's1', date: MON, siteName: 'WB小樽' }),
    ]);
    // staffNo では A が先だが、preferred スコアが上の B が勝つ
    expect(result[0].assignedStaffIds).toEqual(['B']);
  });

  it('preferred は勤務日数バランスより優先される', () => {
    const staff = [
      makeStaff({ id: 'A', staffNo: '1' }),
      makeStaff({ id: 'B', staffNo: '2', preferredWorkSites: ['WB小樽'] }),
    ];
    const sites = [
      makeSite({ id: 'd1', date: MON, siteName: 'WB小樽' }), // B（preferred）
      makeSite({ id: 'd2', date: TUE, siteName: 'WB小樽' }), // B は workDays 1 だが preferred が勝つ
    ];
    const result = generateShifts(staff, sites);
    expect(result[0].assignedStaffIds).toEqual(['B']);
    expect(result[1].assignedStaffIds).toEqual(['B']);
  });

  it('勤務日数が少ないスタッフが優先される（バランス配分）', () => {
    const staff = [
      makeStaff({ id: 'A', staffNo: '1' }),
      makeStaff({ id: 'B', staffNo: '2' }),
    ];
    const sites = [
      makeSite({ id: 'd1', date: MON }),
      makeSite({ id: 'd2', date: TUE }),
    ];
    const result = generateShifts(staff, sites);
    expect(result[0].assignedStaffIds).toEqual(['A']); // 同点 → staffNo 順
    expect(result[1].assignedStaffIds).toEqual(['B']); // A=1日 B=0日 → B 優先
  });

  it('全スコア同点なら staffNo 順（数値比較・数値が非数値より先・空は最後）', () => {
    const staff = [
      makeStaff({ id: 'noNo', staffNo: '' }),
      makeStaff({ id: 'ten',  staffNo: '10' }),
      makeStaff({ id: 'two',  staffNo: '2' }),
      makeStaff({ id: 'alpha', staffNo: 'a1' }),
    ];
    const result = generateShifts(staff, [
      makeSite({ id: 's1', date: MON, requiredPeople: 4 }),
    ]);
    // 数値 2 < 10 → 非数値 'a1' → 空文字は最後
    expect(result[0].assignedStaffIds).toEqual(['two', 'ten', 'alpha', 'noNo']);
  });

  it('preferred の判定は siteName のみで displaySiteName は見ない', () => {
    const staff = [
      makeStaff({ id: 'A', staffNo: '1' }),
      makeStaff({ id: 'B', staffNo: '2', preferredWorkSites: ['WB小樽（2階）'] }),
    ];
    const result = generateShifts(staff, [
      makeSite({ id: 's1', date: MON, siteName: 'WB小樽', displaySiteName: 'WB小樽（2階）' }),
    ]);
    // displaySiteName とは一致するが siteName と不一致 → preferred 加点なし → staffNo 順で A
    expect(result[0].assignedStaffIds).toEqual(['A']);
  });
});

describe('generateShifts: 処理順序', () => {
  it('入力順に関係なく日付の早い現場から人員を確保する', () => {
    const staff = [makeStaff({ id: 'A', maxWorkDays: 1 })];
    // 入力は火曜が先だが、処理は月曜が先 → 上限1日の A は月曜に使われる
    const sites = [
      makeSite({ id: 'tue', date: TUE }),
      makeSite({ id: 'mon', date: MON }),
    ];
    const result = generateShifts(staff, sites);
    expect(result[0]).toMatchObject({ siteId: 'mon', assignedStaffIds: ['A'], shortage: 0 });
    expect(result[1]).toMatchObject({ siteId: 'tue', assignedStaffIds: [], shortage: 1 });
  });

  it('同一日付の現場は入力順を保つ（安定ソート）', () => {
    const staff = [makeStaff({ id: 'A' }), makeStaff({ id: 'B' })];
    const sites = [
      makeSite({ id: 'first',  date: MON }),
      makeSite({ id: 'second', date: MON }),
    ];
    const result = generateShifts(staff, sites);
    expect(result.map((r) => r.siteId)).toEqual(['first', 'second']);
  });
});

describe('generateShifts: sessionPriority（会期優先度）', () => {
  it('S 会期は日付が後でも通常会期より先に処理され、人員枠を先取りする', () => {
    // A は月間上限1日。通常(月曜) と S(火曜) が競合すると S が勝つ。
    const staff = [makeStaff({ id: 'A', maxWorkDays: 1 })];
    const sites = [
      makeSite({ id: 'normalMon', date: MON }),
      makeSite({ id: 'sTue',      date: TUE, sessionPriority: 'S' }),
    ];
    const result = generateShifts(staff, sites);
    const byId = Object.fromEntries(result.map((r) => [r.siteId, r]));
    expect(byId['sTue'].assignedStaffIds).toEqual(['A']);
    expect(byId['normalMon'].assignedStaffIds).toEqual([]);
    expect(byId['normalMon'].shortage).toBe(1);
  });

  it('A 会期は通常会期より先に処理される', () => {
    const staff = [makeStaff({ id: 'A', maxWorkDays: 1 })];
    const sites = [
      makeSite({ id: 'normalMon', date: MON }),
      makeSite({ id: 'aTue',      date: TUE, sessionPriority: 'A' }),
    ];
    const result = generateShifts(staff, sites);
    const byId = Object.fromEntries(result.map((r) => [r.siteId, r]));
    expect(byId['aTue'].assignedStaffIds).toEqual(['A']);
    expect(byId['normalMon'].assignedStaffIds).toEqual([]);
  });

  it('S は A より先に処理される', () => {
    const staff = [makeStaff({ id: 'A', maxWorkDays: 1 })];
    const sites = [
      makeSite({ id: 'aMon', date: MON, sessionPriority: 'A' }),
      makeSite({ id: 'sTue', date: TUE, sessionPriority: 'S' }),
    ];
    const result = generateShifts(staff, sites);
    const byId = Object.fromEntries(result.map((r) => [r.siteId, r]));
    expect(byId['sTue'].assignedStaffIds).toEqual(['A']);
    expect(byId['aMon'].assignedStaffIds).toEqual([]);
  });

  it('priority が同じ場合は現在の並び順（日付昇順・同日は入力順）を維持する', () => {
    const staff = [makeStaff({ id: 'A', maxWorkDays: 1 })];
    // 両方 S → 日付の早い方が先に枠を取る（従来ルールが priority 内で生きる）
    const sites = [
      makeSite({ id: 'sTue', date: TUE, sessionPriority: 'S' }),
      makeSite({ id: 'sMon', date: MON, sessionPriority: 'S' }),
    ];
    const result = generateShifts(staff, sites);
    const byId = Object.fromEntries(result.map((r) => [r.siteId, r]));
    expect(byId['sMon'].assignedStaffIds).toEqual(['A']);
    expect(byId['sTue'].assignedStaffIds).toEqual([]);
  });

  it("priority 未設定と明示 'normal' は同順位（通常扱い）", () => {
    const staff = [makeStaff({ id: 'A', maxWorkDays: 1 })];
    // 未設定(月曜) vs 明示 normal(火曜) → 同順位なので日付順で月曜が勝つ
    const sites = [
      makeSite({ id: 'explicitTue', date: TUE, sessionPriority: 'normal' }),
      makeSite({ id: 'unsetMon',    date: MON }),
    ];
    const result = generateShifts(staff, sites);
    const byId = Object.fromEntries(result.map((r) => [r.siteId, r]));
    expect(byId['unsetMon'].assignedStaffIds).toEqual(['A']);
    expect(byId['explicitTue'].assignedStaffIds).toEqual([]);
  });

  it('全現場が優先度未設定なら従来の処理順（日付昇順のみ）と同一', () => {
    const staff = [makeStaff({ id: 'A', maxWorkDays: 1 })];
    const sites = [
      makeSite({ id: 'tue', date: TUE }),
      makeSite({ id: 'mon', date: MON }),
    ];
    const result = generateShifts(staff, sites);
    // 既存テストと同じ期待値（早い日付が枠を取る）
    expect(result[0]).toMatchObject({ siteId: 'mon', assignedStaffIds: ['A'] });
    expect(result[1]).toMatchObject({ siteId: 'tue', assignedStaffIds: [], shortage: 1 });
  });
});
