export type WebUiLocale = 'ja' | 'en';

export const DEFAULT_LOCALE: WebUiLocale;
export const SUPPORTED_LOCALES: readonly WebUiLocale[];

export function getLocale(): WebUiLocale;
export function translate(key: string, variables?: Readonly<Record<string, unknown>>): string;
export const t: typeof translate;
export function applyTranslations(root?: unknown): void;
export function setLocale(locale: string): WebUiLocale;
export function subscribeLocaleChange(listener: (locale: WebUiLocale) => void): () => boolean;
export function localeLabel(locale?: WebUiLocale): string;
