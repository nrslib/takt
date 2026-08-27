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
    expect(t('map.summarySteps', { steps: 2, passes: 3 })).toBe('2 処理 · 3 ITER');
    expect(t('map.iter', { number: 2 })).toBe('ITER 2');
    expect(t('map.edgeIncoming')).toBe('PREV: 前のITERからこのITERへ');
    expect(t('map.edgeOutgoing')).toBe('NEXT: このITERから次のITERへ');
    expect(t('map.edgeDirection')).toBe('中空円=始点 / 塗り円=終点');
    expect(t('map.edgeLegend')).toBe('選択中ITERの前後関係');
    expect(t('viewer.stepIterations')).toBe('ITER一覧');
    expect(t('viewer.backToStep')).toBe('STEP概要に戻る');
    expect(t('missing.translation.key')).toBe('missing.translation.key');
  });

  it('switches complete UI copy to English and persists the choice', () => {
    let stored = '';
    const storage = {
      getItem: vi.fn(() => stored),
      setItem: vi.fn((_key: string, value: string) => { stored = value; }),
    };
    vi.stubGlobal('localStorage', storage);

    expect(setLocale('en')).toBe('en');
    expect(getLocale()).toBe('en');
    expect(t('app.createTask')).toBe('New task');
    expect(t('map.summarySteps', { steps: 2, passes: 3 })).toBe('2 steps · 3 ITER');
    expect(t('map.iter', { number: 2 })).toBe('ITER 2');
    expect(t('map.edgeIncoming')).toBe('PREV: Previous ITER to this one');
    expect(t('map.edgeOutgoing')).toBe('NEXT: This ITER to the next');
    expect(t('map.edgeDirection')).toBe('Hollow circle = start / filled circle = end');
    expect(t('map.edgeLegend')).toBe('Selected ITER context');
    expect(t('viewer.stepIterations')).toBe('ITER list');
    expect(t('viewer.backToStep')).toBe('Back to step');
    expect(t('task.action.retry')).toBe('Retry');
    expect(t('task.action.instruct')).toBe('Instruct');
    expect(storage.setItem).toHaveBeenCalledWith('takt.ui.locale', 'en');
  });

  it('keeps Japanese UI copy while preserving familiar command labels', () => {
    expect(t('task.action.retry')).toBe('リトライ');
    expect(t('task.action.instruct')).toBe('Instruct');
    expect(t('task.action.diff')).toBe('View diff');
    expect(t('task.action.sync')).toBe('Merge from root');
    expect(t('task.action.pull')).toBe('Pull from remote');
    expect(t('task.action.merge')).toBe('Merge & cleanup');
    expect(t('app.existingTask')).toBe('既存タスク');
    setLocale('en');
    expect(t('app.existingTask')).toBe('Existing task');
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

    expect(text.textContent).toBe('New task');
    expect(placeholder.placeholder).toBe('Describe what you want to discuss');
    expect(title.title).toBe('⌘ Enter to send');
    expect(aria.getAttribute('aria-label')).toBe('Close');
    expect(root.documentElement.lang).toBe('en');
  });
});
