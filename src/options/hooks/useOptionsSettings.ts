import { useCallback, useEffect, useRef, useState } from 'react';
import { STORAGE_KEYS } from '../../shared/constants';
import {
  createDefaultSettings,
  normalizeSettings,
  readExtensionSettings,
  saveExtensionSettings,
} from '../../shared/settings';
import type { ExtensionSettings } from '../../shared/types';

export type SaveState = 'loading' | 'saved' | 'error';
export type SettingsUpdater = (settings: ExtensionSettings) => ExtensionSettings;

interface UseOptionsSettingsResult {
  settings: ExtensionSettings | null;
  saveState: SaveState;
  updateSettings: (updater: SettingsUpdater) => void;
  resetSettings: () => void;
}

/** Owns local optimistic state and serializes writes to browser.storage.local. */
export const useOptionsSettings = (): UseOptionsSettingsResult => {
  const [settings, setSettings] = useState<ExtensionSettings | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('loading');
  const settingsRef = useRef<ExtensionSettings | null>(null);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    let active = true;

    const listener = (
      changes: Record<string, browser.storage.StorageChange>,
      areaName: string,
    ): void => {
      const change = changes[STORAGE_KEYS.extensionSettings];
      if (areaName !== 'local' || !change) return;
      const next = normalizeSettings(change.newValue);
      settingsRef.current = next;
      setSettings(next);
    };
    browser.storage.onChanged.addListener(listener);

    void readExtensionSettings()
      .then((next) => {
        if (!active) return;
        settingsRef.current = next;
        setSettings(next);
        setSaveState('saved');
      })
      .catch(() => {
        if (active) setSaveState('error');
      });

    return () => {
      active = false;
      browser.storage.onChanged.removeListener(listener);
    };
  }, []);

  const enqueueSave = useCallback((updater: SettingsUpdater): void => {
    setSaveState('loading');
    saveQueueRef.current = saveQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        const next = updater(await readExtensionSettings());
        await saveExtensionSettings(next);
        setSaveState('saved');
      })
      .catch(() => {
        setSaveState('error');
      });
  }, []);

  const updateSettings = useCallback(
    (updater: SettingsUpdater): void => {
      const current = settingsRef.current;
      if (!current) return;
      const next = updater(current);
      settingsRef.current = next;
      setSettings(next);
      enqueueSave(updater);
    },
    [enqueueSave],
  );

  const resetSettings = useCallback((): void => {
    const next = createDefaultSettings();
    settingsRef.current = next;
    setSettings(next);
    enqueueSave(createDefaultSettings);
  }, [enqueueSave]);

  return { settings, saveState, updateSettings, resetSettings };
};
