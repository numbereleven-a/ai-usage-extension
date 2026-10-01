import { useCallback, useEffect, useState } from 'react';
import { STORAGE_KEYS } from '../../shared/constants';
import { msg } from '../../shared/i18n';
import { readUsageState, requestUsageRefresh } from '../../shared/messaging';
import { readExtensionSettings, saveExtensionSettings } from '../../shared/settings';
import type { ExtensionSettings, UsageState } from '../../shared/types';

export interface UsageData {
  usage: UsageState;
  settings: ExtensionSettings | null;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  changingRefreshMode: boolean;
  refresh: () => Promise<void>;
  toggleRefreshMode: () => Promise<void>;
}

export const useUsageData = (): UsageData => {
  const [usage, setUsage] = useState<UsageState>({});
  const [settings, setSettings] = useState<ExtensionSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [changingRefreshMode, setChangingRefreshMode] = useState(false);

  useEffect(() => {
    let active = true;

    const hydrate = async (): Promise<void> => {
      const [state, preferences] = await Promise.all([readUsageState(), readExtensionSettings()]);

      if (!active) {
        return;
      }

      setUsage(state);
      setSettings(preferences);
      if (preferences.refresh.mode === 'manual') {
        setLoading(false);
        return;
      }
      setRefreshing(true);
      try {
        const next = await requestUsageRefresh(true);
        if (active) setUsage(next);
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : msg('refreshFailed'));
      } finally {
        if (active) {
          setRefreshing(false);
          setLoading(false);
        }
      }
    };

    void hydrate().catch((cause: unknown) => {
      if (active) {
        setError(cause instanceof Error ? cause.message : msg('refreshFailed'));
        setLoading(false);
      }
    });

    const listener = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string,
    ): void => {
      if (areaName !== 'local') {
        return;
      }

      if (changes[STORAGE_KEYS.usageState]) {
        setUsage((changes[STORAGE_KEYS.usageState].newValue ?? {}) as UsageState);
      }

      if (changes[STORAGE_KEYS.extensionSettings]) {
        void readExtensionSettings().then((next) => {
          if (active) setSettings(next);
        });
      }
    };

    chrome.storage.onChanged.addListener(listener);
    return () => {
      active = false;
      chrome.storage.onChanged.removeListener(listener);
    };
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    setRefreshing(true);
    setError(null);
    try {
      setUsage(await requestUsageRefresh());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : msg('refreshFailed'));
    } finally {
      setRefreshing(false);
    }
  }, []);

  const toggleRefreshMode = useCallback(async (): Promise<void> => {
    setChangingRefreshMode(true);
    setError(null);
    try {
      const current = await readExtensionSettings();
      const next: ExtensionSettings = {
        ...current,
        refresh: {
          ...current.refresh,
          mode: current.refresh.mode === 'manual' ? 'auto' : 'manual',
        },
      };
      await saveExtensionSettings(next);
      setSettings(next);
    } catch {
      setError(msg('optionsSaveError'));
    } finally {
      setChangingRefreshMode(false);
    }
  }, []);

  return {
    usage,
    settings,
    loading,
    refreshing,
    error,
    changingRefreshMode,
    refresh,
    toggleRefreshMode,
  };
};
