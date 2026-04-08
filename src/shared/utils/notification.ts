/**
 * Notification utilities for takt
 *
 * Provides audio and visual notifications for workflow events.
 */

import { execFile } from 'node:child_process';
import { platform } from 'node:os';

/** Notification sound types */
export type NotificationSound = 'success' | 'error' | 'warning' | 'info';

/** Sound configuration */
const SOUND_CONFIG: Record<string, Record<NotificationSound, string>> = {
  darwin: {
    success: 'Glass',
    error: 'Basso',
    warning: 'Sosumi',
    info: 'Pop',
  },
  linux: {
    success: '/usr/share/sounds/freedesktop/stereo/complete.oga',
    error: '/usr/share/sounds/freedesktop/stereo/dialog-error.oga',
    warning: '/usr/share/sounds/freedesktop/stereo/dialog-warning.oga',
    info: '/usr/share/sounds/freedesktop/stereo/message.oga',
  },
};

/**
 * Play a notification sound
 *
 * @param type - The type of notification sound to play
 */
export function playSound(type: NotificationSound = 'info'): void {
  const os = platform();

  try {
    if (os === 'darwin') {
      const darwinConfig = SOUND_CONFIG.darwin;
      const sound = darwinConfig ? darwinConfig[type] : 'Pop';
      execFile('afplay', [`/System/Library/Sounds/${sound}.aiff`], (err) => {
        if (err) process.stdout.write('\x07');
      });
    } else if (os === 'linux') {
      const linuxConfig = SOUND_CONFIG.linux;
      const sound = linuxConfig ? linuxConfig[type] : '/usr/share/sounds/freedesktop/stereo/message.oga';
      execFile('paplay', [sound], (paplayError) => {
        if (!paplayError) return;
        execFile('aplay', [sound], (aplayError) => {
          if (aplayError) process.stdout.write('\x07');
        });
      });
    } else {
      process.stdout.write('\x07');
    }
  } catch {
    process.stdout.write('\x07');
  }
}

/**
 * Play success notification sound
 */
export function playSuccessSound(): void {
  playSound('success');
}

/**
 * Play error notification sound
 */
export function playErrorSound(): void {
  playSound('error');
}

/**
 * Play warning notification sound
 */
export function playWarningSound(): void {
  playSound('warning');
}

/**
 * Play info notification sound
 */
export function playInfoSound(): void {
  playSound('info');
}

/** Options for system notification */
export interface NotifyOptions {
  /** Notification title */
  title: string;
  /** Notification message/body */
  message: string;
  /** Optional subtitle (macOS only) */
  subtitle?: string;
  /** Sound type to play with notification */
  sound?: NotificationSound;
}

/**
 * Send a system notification
 *
 * @param options - Notification options
 */
export function sendNotification(options: NotifyOptions): void {
  const os = platform();
  const { title, message, subtitle, sound } = options;

  try {
    if (os === 'darwin') {
      const subtitlePart = subtitle ? `subtitle "${escapeAppleScript(subtitle)}"` : '';
      const soundPart = sound ? `sound name "${SOUND_CONFIG.darwin?.[sound] || 'Pop'}"` : '';
      const script = `display notification "${escapeAppleScript(message)}" with title "${escapeAppleScript(title)}" ${subtitlePart} ${soundPart}`;
      execFile('osascript', ['-e', script], (err) => {
        if (err && sound) playSound(sound);
      });
    } else if (os === 'linux') {
      const urgency = sound === 'error' ? 'critical' : sound === 'warning' ? 'normal' : 'low';
      execFile('notify-send', ['-u', urgency, title, message], () => {
        if (sound) playSound(sound);
      });
    } else {
      if (sound) playSound(sound);
    }
  } catch {
    if (sound) playSound(sound);
  }
}

/**
 * Escape string for AppleScript
 */
function escapeAppleScript(str: string): string {
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Send success notification with sound
 */
export function notifySuccess(title: string, message: string): void {
  sendNotification({ title, message, sound: 'success' });
}

/**
 * Send error notification with sound
 */
export function notifyError(title: string, message: string): void {
  sendNotification({ title, message, sound: 'error' });
}

/**
 * Send warning notification with sound
 */
export function notifyWarning(title: string, message: string): void {
  sendNotification({ title, message, sound: 'warning' });
}

/**
 * Send info notification with sound
 */
export function notifyInfo(title: string, message: string): void {
  sendNotification({ title, message, sound: 'info' });
}
