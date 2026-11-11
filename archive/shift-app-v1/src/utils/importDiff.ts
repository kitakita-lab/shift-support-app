import { WorkSite } from '../types';
import { buildSiteIdentityKey } from './shiftNormalize';

export interface ImportDiffResult {
  addedCount:     number;
  removedCount:   number;
  updatedCount:   number;
  unchangedCount: number;
  /** source==='manual' または isManuallyEdited===true により保護された旧バッチ件数 */
  protectedCount: number;
}

function isProtected(site: WorkSite): boolean {
  return site.source === 'manual' || site.isManuallyEdited === true;
}

function dayKey(site: WorkSite): string {
  const identityKey = site.siteIdentityKey ?? buildSiteIdentityKey(site.siteName, site.subSiteName, site.clientName);
  return `${site.date}\0${identityKey}`;
}

function daySettings(site: WorkSite): string {
  return `${site.startTime}\0${site.endTime}\0${site.requiredPeople}`;
}

/**
 * 既存バッチの WorkSite と新規インポート候補を日単位で比較して差分を返す。
 * キー: date + siteIdentityKey（表記ゆれ吸収済み会場同一性キー）。
 * 保護対象（source==='manual' || isManuallyEdited===true）は比較から除外し protectedCount に計上。
 * 自動削除・自動更新はしない。ユーザー確認後に置換する方式で使う。
 */
export function diffImportBatch(
  oldSites: WorkSite[],
  newSites: WorkSite[],
): ImportDiffResult {
  const protectedSites = oldSites.filter(isProtected);
  const deletableSites = oldSites.filter((s) => !isProtected(s));

  const oldMap = new Map<string, string>();
  for (const s of deletableSites) oldMap.set(dayKey(s), daySettings(s));

  const newMap = new Map<string, string>();
  for (const s of newSites) newMap.set(dayKey(s), daySettings(s));

  let addedCount     = 0;
  let updatedCount   = 0;
  let unchangedCount = 0;

  for (const [key, settings] of newMap) {
    if (!oldMap.has(key))                 addedCount++;
    else if (oldMap.get(key) !== settings) updatedCount++;
    else                                   unchangedCount++;
  }

  let removedCount = 0;
  for (const key of oldMap.keys()) {
    if (!newMap.has(key)) removedCount++;
  }

  return { addedCount, removedCount, updatedCount, unchangedCount, protectedCount: protectedSites.length };
}
