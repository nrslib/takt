import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { selectOption } from '../../shared/prompt/index.js';
import type { SelectOptionItem } from '../../shared/prompt/index.js';
import { getLanguage } from '../../infra/config/index.js';
import { getLanguageResourcesDir } from '../../infra/resources/index.js';
import { ejectBuiltin, ejectFacet, parseFacetType, type EjectOptions } from './ejectBuiltin.js';
import type { Language } from '../../core/models/index.js';

export interface EjectMenuItem {
  name: string;
  type: 'piece' | 'facet';
  facet_type?: string;
  scope: 'local' | 'global';
  description: string;
}

export interface EjectMenuSubcategory {
  items?: EjectMenuItem[];
  subcategories?: Record<string, EjectMenuSubcategory>;
}

export interface EjectMenuCategory {
  items?: EjectMenuItem[];
  subcategories?: Record<string, EjectMenuSubcategory>;
}

export interface EjectMenu {
  eject_menu: Record<string, EjectMenuCategory>;
}

const CATEGORY_PREFIX = '__category__:';

function loadEjectMenu(lang: Language): EjectMenu {
  const menuPath = join(getLanguageResourcesDir(lang), 'eject-menu.yaml');
  const content = readFileSync(menuPath, 'utf-8');
  return parseYaml(content) as EjectMenu;
}

export function buildOptionsFromMenu(
  menu: Record<string, EjectMenuCategory> | EjectMenuSubcategory,
  prefix = '',
): SelectOptionItem<string>[] {
  const options: SelectOptionItem<string>[] = [];

  const category = menu as EjectMenuCategory;
  const subcategories = category.subcategories;
  const items = category.items;

  if (subcategories) {
    for (const [name] of Object.entries(subcategories)) {
      const label = `${prefix}📁 ${name}/`;
      options.push({ label, value: `${CATEGORY_PREFIX}${name}` });
    }
  }

  if (items) {
    for (const item of items) {
      const label = `${prefix}🎯 ${item.name} (${item.description})`;
      options.push({ label, value: item.name, description: item.description });
    }
  }

  return options;
}

export function findItemInMenu(
  menu: Record<string, EjectMenuCategory>,
  itemName: string,
): EjectMenuItem | null {
  for (const category of Object.values(menu)) {
    const found = findItemInCategory(category, itemName);
    if (found) return found;
  }
  return null;
}

function findItemInCategory(
  category: EjectMenuCategory,
  itemName: string,
): EjectMenuItem | null {
  if (category.items) {
    const item = category.items.find((i) => i.name === itemName);
    if (item) return item;
  }

  if (category.subcategories) {
    for (const sub of Object.values(category.subcategories)) {
      const found = findItemInCategory(sub as EjectMenuCategory, itemName);
      if (found) return found;
    }
  }

  return null;
}

export function findSubcategory(
  menu: Record<string, EjectMenuCategory>,
  categoryName: string,
): EjectMenuSubcategory | null {
  for (const category of Object.values(menu)) {
    if (category.subcategories) {
      const found = category.subcategories[categoryName];
      if (found) return found;
    }
  }
  return null;
}

async function selectFromMenu(
  category: EjectMenuCategory,
  currentPath: string,
): Promise<{ name: string; item: EjectMenuItem | null } | null> {
  while (true) {
    const isRoot = currentPath === '';
    const displayPath = isRoot ? '' : `${currentPath}: `;

    const options = buildOptionsFromMenu(category, isRoot ? '' : '  ');

    if (options.length === 0) {
      return null;
    }

    const selected = await selectOption<string>(
      `${displayPath}Select eject target:`,
      options,
      { cancelLabel: isRoot ? 'Cancel' : '← Go back' },
    );

    if (!selected) {
      if (isRoot) {
        return null;
      }
      return { name: '__go_back__', item: null };
    }

    if (selected.startsWith(CATEGORY_PREFIX)) {
      const categoryName = selected.slice(CATEGORY_PREFIX.length);
      const subcategory = category.subcategories?.[categoryName];
      if (subcategory) {
        const subResult = await selectFromMenu(
          subcategory as EjectMenuCategory,
          categoryName,
        );
        if (subResult && subResult.name !== '__go_back__') {
          return subResult;
        }
      }
      continue;
    }

    const item = findItemInCategory(category, selected);
    if (item) {
      return { name: selected, item };
    }
  }
}

export async function ejectInteractive(projectDir: string, globalOverride = false): Promise<void> {
  const lang = getLanguage();
  const menu = loadEjectMenu(lang).eject_menu;

  const topLevelOptions: SelectOptionItem<string>[] = Object.keys(menu).map((name) => ({
    label: `📁 ${name}/`,
    value: name,
  }));

  if (topLevelOptions.length === 0) {
    return;
  }

  const selectedCategory = await selectOption<string>(
    'Select category:',
    topLevelOptions,
  );

  if (!selectedCategory) {
    return;
  }

  const category = menu[selectedCategory];
  if (!category) {
    return;
  }

  const result = await selectFromMenu(category, selectedCategory);

  if (!result || result.name === '__go_back__') {
    return;
  }

  const { name, item } = result;

  if (!item) {
    return;
  }

  const ejectOptions: EjectOptions = {
    global: globalOverride || item.scope === 'global',
    projectDir,
  };

  if (item.type === 'piece') {
    await ejectBuiltin(name, ejectOptions);
  } else if (item.type === 'facet' && item.facet_type) {
    const facetType = parseFacetType(item.facet_type);
    if (facetType) {
      await ejectFacet(facetType, name, ejectOptions);
    }
  }
}
