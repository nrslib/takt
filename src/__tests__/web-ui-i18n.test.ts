import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_LOCALE,
  getLocale,
  setLocale,
  t,
  applyTranslations,
} from '../../web-ui/public/i18n.js';

class TranslationNode {
  textContent = '';
  placeholder = '';
  title = '';
  readonly attributes = new Map<string, string>();
  readonly children: TranslationNode[] = [];

  constructor(readonly key: string, readonly attribute = 'data-i18n') {
    this.attributes.set(attribute, key);
  }

  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }

  querySelectorAll() {
    return this.children;
  }
}

describe('Web UI i18n', () => {
  beforeEach(() => {
    setLocale(DEFAULT_LOCALE);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses Japanese as the canonical default and supports interpolation/fallback', () => {
    expect(DEFAULT_LOCALE).toBe('ja');
    expect(getLocale()).toBe('ja');
    const summary = t('map.summarySteps', { steps: 17, passes: 29 });
    expect(summary).toContain('17');
    expect(summary).toContain('29');
    expect(summary).not.toMatch(/\{(?:steps|passes)\}/u);
    expect(t('missing.translation.key')).toBe('missing.translation.key');
  });

  it('switches the translated label to English and persists the choice', () => {
    let stored = '';
    const storage = {
      getItem: vi.fn(() => stored),
      setItem: vi.fn((_key: string, value: string) => { stored = value; }),
    };
    vi.stubGlobal('localStorage', storage);

    const japanese = t('app.createTask');
    expect(japanese).toMatch(/\S/u);
    expect(japanese).not.toBe('app.createTask');
    expect(setLocale('en')).toBe('en');
    expect(getLocale()).toBe('en');
    expect(t('app.createTask')).toMatch(/\S/u);
    expect(t('app.createTask')).not.toBe(japanese);
    expect(t('app.createTask')).not.toBe('app.createTask');
    expect(storage.setItem).toHaveBeenCalledWith('takt.ui.locale', 'en');
  });

  it('translates static text, placeholder, title, and aria label attributes', () => {
    const text = new TranslationNode('app.createTask');
    const placeholder = new TranslationNode('app.messagePlaceholder', 'data-i18n-placeholder');
    const title = new TranslationNode('app.sendShortcut', 'data-i18n-title');
    const aria = new TranslationNode('app.close', 'data-i18n-aria-label');
    const root = {
      documentElement: { lang: '' },
      querySelectorAll: () => [text, placeholder, title, aria],
    };

    setLocale('en');
    applyTranslations(root);

    expect(text.textContent).toBe(t('app.createTask'));
    expect(placeholder.placeholder).toBe(t('app.messagePlaceholder'));
    expect(title.title).toBe(t('app.sendShortcut'));
    expect(aria.getAttribute('aria-label')).toBe(t('app.close'));
    expect(root.documentElement.lang).toBe('en');
  });
});
