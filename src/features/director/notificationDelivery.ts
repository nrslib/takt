import type { DirectorNotification } from '../../infra/conversations/directorNotifications.js';

export interface DirectorNotificationDelivery {
  deliver(notifications: readonly DirectorNotification[]): Promise<void>;
}
