import { STORAGE_KEYS } from '../constants';

export const sharedDistinctId = async (): Promise<string> => {
  const stored = await browser.storage.local.get(STORAGE_KEYS.distinctId);
  const existing = stored[STORAGE_KEYS.distinctId] as string | undefined;
  if (existing) return existing;

  const distinctId = crypto.randomUUID();
  await browser.storage.local.set({ [STORAGE_KEYS.distinctId]: distinctId });
  return distinctId;
};
