import { WorkSite } from '../types';
import { normalizeSiteIdentity } from './shiftNormalize';

export interface ImportDiffResult {
  addedCount:     number;
  removedCount:   number;
  updatedCount:   number;
  unchangedCount: number;
}

function dayKey(site: WorkSite): string {
  const normKey = site.normalizedSiteKey ?? normalizeSiteIdentity(site.siteName, site.clientName);
  return `${site.date}\0${normKey}`;
}

function daySettings(site: WorkSite): string {
  return `${site.startTime}\0${site.endTime}\0${site.requiredPeople}`;
}

/**
 * 既存バッチの WorkSite と新規インポート候補を日単位で比較して差分を返す。
 * キー: date + normalizedSiteKey。
 * 自動削除・自動更新はしない。ユーザー確認後に置換する方式で使う。
 */
export function diffImportBatch(
  oldSites: WorkSite[],
  newSites: WorkSite[],
): ImportDiffResult {
  const oldMap = new Map<string, string>();
  for (const s of oldSites) oldMap.set(dayKey(s), daySettings(s));

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

  return { addedCount, removedCount, updatedCount, unchangedCount };
}
