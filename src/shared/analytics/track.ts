import type { ExtensionMessage, MessageResponse } from '../types';
import type { AnalyticsContext, AnalyticsEventName, AnalyticsEvents } from './events';
import { REPORT_DATA_PERMISSIONS } from '../constants';

export const trackFrom =
  (context: AnalyticsContext) =>
  async <Name extends AnalyticsEventName>(
    event: Name,
    properties: AnalyticsEvents[Name],
  ): Promise<boolean> => {
    // Request directly from the Send click to preserve Firefox's user gesture.
    if (!(await browser.permissions.request(REPORT_DATA_PERMISSIONS).catch(() => false))) {
      return false;
    }
    const message: ExtensionMessage = { type: 'TRACK', context, event, properties };
    const response = (await browser.runtime.sendMessage(message).catch(() => undefined)) as
      | MessageResponse<null>
      | undefined;

    return response?.success === true;
  };
