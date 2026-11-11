import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Staff, WorkSite } from '../types';
import { storage, hydrateWorkSite } from './storage';

// ─────────────────────────────────────────────────────────────
// hydrateWorkSite は旧スキーマの localStorage / Firestore データを
// 現行の WorkSite 型に安全に復元する唯一の互換レイヤー。
// フィールド追加時にここを壊すと「古いデータが読めない・消える」
// 事故になるため、補完仕様を固定する。
// ─────────────────────────────────────────────────────────────

describe('hydrateWorkSite', () => {
  it('空オブジェクトから必須フィールドをデフォルト補完する', () => {
    const s = hydrateWorkSite({});
    expect(s.id).toBeTruthy();            // id は自動生成される
    expect(s.date).toBe('');
    expect(s.siteName).toBe('');
    expect(s.startTime).toBe('');
    expect(s.endTime).toBe('');
    expect(s.requiredPeople).toBe(1);
    expect(s.memo).toBe('');
  });

  it('指定された値はそのまま保持する（デフォルトで上書きしない）', () => {
    const s = hydrateWorkSite({
      id: 'fixed-id',
      date: '2026-06-01',
      siteName: 'Bivi新札幌',
      startTime: '09:00',
      endTime: '18:00',
      requiredPeople: 3,
      memo: 'メモ',
    });
    expect(s).toMatchObject({
      id: 'fixed-id',
      date: '2026-06-01',
      siteName: 'Bivi新札幌',
      startTime: '09:00',
      endTime: '18:00',
      requiredPeople: 3,
      memo: 'メモ',
    });
  });

  it('requiredPeople が 0 の場合は 0 を保持する（?? はゼロを潰さない）', () => {
    expect(hydrateWorkSite({ requiredPeople: 0 }).requiredPeople).toBe(0);
  });

  it('省略されたオプションフィールドはプロパティ自体を付与しない', () => {
    const s = hydrateWorkSite({ siteName: 'A' });
    expect(s).not.toHaveProperty('groupId');
    expect(s).not.toHaveProperty('clientName');
    expect(s).not.toHaveProperty('sessionId');
    expect(s).not.toHaveProperty('sessionPriority');
    expect(s).not.toHaveProperty('siteIdentityKey');
  });

  it('null のオプションフィールドはコピーしない（旧 JSON データ互換）', () => {
    // 旧データや外部由来 JSON では null が入ることがある
    const raw = { clientName: null, groupId: null } as unknown as Partial<WorkSite>;
    const s = hydrateWorkSite(raw);
    expect(s).not.toHaveProperty('clientName');
    expect(s).not.toHaveProperty('groupId');
  });

  it('存在するオプションフィールドはすべてコピーする', () => {
    const s = hydrateWorkSite({
      groupId: 'g1',
      groupLabel: 'ラベル',
      sessionId: 'sess1',
      clientName: 'クライアント',
      rawSiteName: '原文',
      subSiteName: '2階',
      displaySiteName: '会場（2階）',
      isPlaceholder: false,
      source: 'csv',
      isManuallyEdited: true,
      manualEditedAt: '2026-06-01T00:00:00.000Z',
      sourceFileName: 'list.xlsx',
      importedAt: '2026-06-01T00:00:00.000Z',
      importBatchId: 'batch1',
      sessionPriority: 'S',
    });
    expect(s.groupId).toBe('g1');
    expect(s.groupLabel).toBe('ラベル');
    expect(s.sessionId).toBe('sess1');
    expect(s.clientName).toBe('クライアント');
    expect(s.rawSiteName).toBe('原文');
    expect(s.subSiteName).toBe('2階');
    expect(s.displaySiteName).toBe('会場（2階）');
    expect(s.isPlaceholder).toBe(false);
    expect(s.source).toBe('csv');
    expect(s.isManuallyEdited).toBe(true);
    expect(s.sourceFileName).toBe('list.xlsx');
    expect(s.importBatchId).toBe('batch1');
    expect(s.sessionPriority).toBe('S');
  });

  describe('siteIdentityKey の後方互換補完', () => {
    it('siteIdentityKey が存在すればそのまま使う', () => {
      const s = hydrateWorkSite({ siteIdentityKey: 'key-a', normalizedSiteKey: 'key-b' });
      expect(s.siteIdentityKey).toBe('key-a');
      expect(s.normalizedSiteKey).toBe('key-b');
    });

    it('siteIdentityKey がなく normalizedSiteKey があれば流用する（旧データ）', () => {
      const s = hydrateWorkSite({ normalizedSiteKey: 'key-b' });
      expect(s.siteIdentityKey).toBe('key-b');
    });

    it('両方なければ siteIdentityKey は付与しない（次回 normalize で付与）', () => {
      const s = hydrateWorkSite({ siteName: 'A' });
      expect(s).not.toHaveProperty('siteIdentityKey');
    });
  });

  it('旧スキーマ（v1: 基本フィールドのみ）のレコードを完全に復元できる', () => {
    // groupId / sessionId / source 等が存在しなかった時代のデータ
    const legacy = {
      id: 'old-1',
      date: '2025-01-15',
      siteName: '旧現場',
      startTime: '10:00',
      endTime: '19:00',
      requiredPeople: 2,
      memo: '',
    };
    const s = hydrateWorkSite(legacy);
    expect(s).toMatchObject(legacy);
    expect(s).not.toHaveProperty('groupId');
    expect(s).not.toHaveProperty('sessionPriority');
  });
});

// ─────────────────────────────────────────────────────────────
// スタッフ永続化の後方互換テスト。
// loadStaff は旧スキーマ（フィールド欠落）のレコードにデフォルトを補完する。
// StaffManager の入力UI（maxWorkDays / availableWeekdays）が依存する
// 「未入力・旧データでも安全に読める」保証を固定する。
// ─────────────────────────────────────────────────────────────

describe('storage.saveStaff / loadStaff', () => {
  let store: Record<string, string>;

  beforeEach(() => {
    store = {};
    vi.stubGlobal('localStorage', {
      getItem:    (k: string) => store[k] ?? null,
      setItem:    (k: string, v: string) => { store[k] = v; },
      removeItem: (k: string) => { delete store[k]; },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const fullStaff: Staff = {
    id: 's1',
    staffNo: '3',
    name: '山田',
    availableWeekdays: ['月', '水'],
    requestedDaysOff: ['2026-06-10'],
    maxWorkDays: 12,
    maxConsecutiveDays: 4,
    memo: 'メモ',
    preferredWorkSites: ['WB小樽'],
    ngPartnerIds: ['s2'],
  };

  it('保存 → 読込で maxWorkDays / availableWeekdays が往復保持される', () => {
    storage.saveStaff([fullStaff]);
    const loaded = storage.loadStaff();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].maxWorkDays).toBe(12);
    expect(loaded[0].availableWeekdays).toEqual(['月', '水']);
    expect(loaded[0]).toEqual(fullStaff);
  });

  it('availableWeekdays 空配列（=全曜日可）は空配列のまま維持される', () => {
    storage.saveStaff([{ ...fullStaff, availableWeekdays: [] }]);
    expect(storage.loadStaff()[0].availableWeekdays).toEqual([]);
  });

  it('旧スキーマ（フィールド欠落）のレコードにデフォルトを補完する', () => {
    // maxWorkDays / availableWeekdays 等が存在しなかった時代のデータ
    store['shift_staff'] = JSON.stringify([{ id: 'old-1', name: '旧スタッフ' }]);
    const loaded = storage.loadStaff();
    expect(loaded[0]).toEqual({
      id: 'old-1',
      name: '旧スタッフ',
      staffNo: '',
      availableWeekdays: [],
      requestedDaysOff: [],
      maxWorkDays: 20,
      maxConsecutiveDays: 5,
      memo: '',
      preferredWorkSites: [],
      ngPartnerIds: [],
    });
  });

  it('既存データの設定値はデフォルトで上書きされない（CSVインポート由来等）', () => {
    store['shift_staff'] = JSON.stringify([
      { id: 'csv-1', name: 'CSV由来', maxWorkDays: 8, availableWeekdays: ['土', '日'] },
    ]);
    const loaded = storage.loadStaff();
    expect(loaded[0].maxWorkDays).toBe(8);
    expect(loaded[0].availableWeekdays).toEqual(['土', '日']);
  });

  it('壊れた JSON は空配列を返す（クラッシュしない）', () => {
    store['shift_staff'] = '{broken';
    expect(storage.loadStaff()).toEqual([]);
  });
});
