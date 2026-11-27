import type { DirectorNotification } from '../../infra/daemon/notifications.js';

export interface DirectorNotificationDelivery {
  deliver(notifications: readonly DirectorNotification[]): Promise<void>;
}
