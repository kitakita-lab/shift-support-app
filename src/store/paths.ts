// 共有データ（Firestore）の置き場所。アプリはここで組み立てた場所だけを使う。
// 一覧は collections.json にあり、ルール案（firestore.v3.rules）と一致していることを e2e/sync/rules.mjs が確かめる。
//
//   teams/{チーム}/wsStaff|wsVenues|wsContents|wsPartTypes|wsComposites/{id} … マスタ。1 件＝1 ドキュメント
//   teams/{チーム}/wsProjects/{id}                                           … 案件。1 件＝1 ドキュメント
//   teams/{チーム}/wsMeta/state                                              … 形式の版・移行の記録
//   teams/{チーム}/wsBackups/{id}                                            … 移行前のバックアップ
//   teams/{チーム}/members/{メールアドレス（小文字）}                          … メンバー名簿
//   teams/{チーム}/workshopData|workshopProjects/…                           … V1・V2 の形式（移行元。読むだけ）
//   teams/{チーム}/wsRulesProbe/probe                                        … 何も置かない。ルールが名簿で制限しているかを確かめるために読んでみる場所
//
// 新しい形式は、古いアプリ（V1・V2）のコードが参照しない名前（ws…）に置く。古いアプリが何を書いても届かない。
import colls from './collections.json';

/** 通常の（実際の運用で使っている）チームの名前 */
export const DEFAULT_TEAM_ID = 'intention-dev';
export const TEAM_ID: string = import.meta.env.VITE_TEAM_ID || DEFAULT_TEAM_ID;
/**
 * 検証用のビルドか（環境変数 VITE_TEAM_ID で、通常とは別のチーム名を指定してビルドした）。
 * 共有データの場所は、すべて TEAM_ID から組み立てる（下の collPath・docPath）ので、検証用のビルドは、
 * 通常のチームの共有データを読み書きする経路を持たない。画面には、検証用のビルドであることを常に表示する。
 * これは、誤って通常の共有データを操作しないための分け方で、権限の境界ではない（誰が何を読み書きできるかは、Firestore のルールが決める）。
 */
export const IS_VERIFY_BUILD = TEAM_ID !== DEFAULT_TEAM_ID;

export type MasterKey = 'staff' | 'venues' | 'contents' | 'partTypes' | 'composites';
export const MASTER_KEYS: MasterKey[] = ['staff', 'venues', 'contents', 'partTypes', 'composites'];

export const MASTER_COLL: Record<MasterKey, string> = {
  staff: 'wsStaff', venues: 'wsVenues', contents: 'wsContents', partTypes: 'wsPartTypes', composites: 'wsComposites',
};
export const PROJECT_COLL = 'wsProjects';
export const META_COLL: string = colls.meta;
export const META_DOC = 'state';
export const BACKUP_COLL: string = colls.backups;
export const MEMBER_COLL: string = colls.members;
/**
 * 何も置かない場所。メンバー制のルールでは誰にも許可されない。ここを読めたら「ルールが名簿で制限していない」と分かる
 * （現在のルールは、ログインしていればチーム配下をすべて読み書きできる）。
 */
export const PROBE_COLL: string = colls.probe;
export const PROBE_DOC = 'probe';
/** V1・V2 の形式（移行元） */
export const LEGACY_DATA_COLL = 'workshopData';
export const LEGACY_PROJECT_COLL = 'workshopProjects';

/** アプリが読み書きする「新しい形式」の場所（collections.json の app と同じであること。paths.test.ts） */
export const APP_COLLS: string[] = [...Object.values(MASTER_COLL), PROJECT_COLL];

export const collPath = (coll: string): [string, string, string] => ['teams', TEAM_ID, coll];
export const docPath = (coll: string, id: string): [string, string, string, string] => ['teams', TEAM_ID, coll, id];

/** このアプリが理解できる共有データの形式の版。これより新しい形式のデータには手を出さない */
export const FORMAT_VERSION = 1;
