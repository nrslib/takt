import { describe, it, expect } from 'vitest';
import {
  type EjectMenu,
  type EjectMenuItem,
  type EjectMenuCategory,
} from '../features/config/ejectInteractive.js';

describe('EjectMenu types', () => {
  it('should define EjectMenuItem correctly', () => {
    const item: EjectMenuItem = {
      name: 'default',
      type: 'piece',
      scope: 'local',
      description: 'Standard development piece',
    };
    expect(item.name).toBe('default');
    expect(item.type).toBe('piece');
    expect(item.scope).toBe('local');
  });

  it('should define facet item correctly', () => {
    const item: EjectMenuItem = {
      name: 'coder',
      type: 'facet',
      facet_type: 'personas',
      scope: 'global',
      description: 'Coder persona',
    };
    expect(item.name).toBe('coder');
    expect(item.type).toBe('facet');
    expect(item.facet_type).toBe('personas');
    expect(item.scope).toBe('global');
  });

  it('should define EjectMenuCategory correctly', () => {
    const category: EjectMenuCategory = {
      subcategories: {
        'Quick Start': {
          items: [
            {
              name: 'default',
              type: 'piece',
              scope: 'local',
              description: 'Standard piece',
            },
          ],
        },
      },
    };
    expect(category.subcategories).toBeDefined();
    expect(category.subcategories?.['Quick Start'].items?.[0].name).toBe('default');
  });

  it('should define EjectMenu correctly', () => {
    const menu: EjectMenu = {
      eject_menu: {
        Pieces: {
          subcategories: {
            'Quick Start': {
              items: [
                {
                  name: 'default',
                  type: 'piece',
                  scope: 'local',
                  description: 'Standard piece',
                },
              ],
            },
          },
        },
        Facets: {
          subcategories: {
            Personas: {
              items: [
                {
                  name: 'coder',
                  type: 'facet',
                  facet_type: 'personas',
                  scope: 'local',
                  description: 'Coder persona',
                },
              ],
            },
          },
        },
      },
    };

    expect(menu.eject_menu.Pieces).toBeDefined();
    expect(menu.eject_menu.Facets).toBeDefined();
    expect(menu.eject_menu.Pieces.subcategories?.['Quick Start'].items?.[0].name).toBe('default');
    expect(menu.eject_menu.Facets.subcategories?.Personas.items?.[0].name).toBe('coder');
  });
});

describe('buildOptionsFromMenu', async () => {
  const { buildOptionsFromMenu } = await import('../features/config/ejectInteractive.js');

  it('should build options from menu with items', () => {
    const menu: EjectMenuCategory = {
      items: [
        {
          name: 'default',
          type: 'piece',
          scope: 'local',
          description: 'Standard piece',
        },
      ],
    };

    const options = buildOptionsFromMenu(menu);
    expect(options).toHaveLength(1);
    expect(options[0].value).toBe('default');
    expect(options[0].label).toContain('default');
  });

  it('should build options from menu with subcategories', () => {
    const menu: EjectMenuCategory = {
      subcategories: {
        'Quick Start': {
          items: [
            {
              name: 'default',
              type: 'piece',
              scope: 'local',
              description: 'Standard piece',
            },
          ],
        },
      },
    };

    const options = buildOptionsFromMenu(menu);
    expect(options).toHaveLength(1);
    expect(options[0].value).toContain('__category__');
    expect(options[0].label).toContain('Quick Start');
  });

  it('should build options from menu with both items and subcategories', () => {
    const menu: EjectMenuCategory = {
      subcategories: {
        'Quick Start': {
          items: [{ name: 'default', type: 'piece', scope: 'local', description: 'Standard' }],
        },
      },
      items: [{ name: 'passthrough', type: 'piece', scope: 'local', description: 'Passthrough' }],
    };

    const options = buildOptionsFromMenu(menu);
    expect(options).toHaveLength(2);
  });
});

describe('findItemInMenu', async () => {
  const { findItemInMenu } = await import('../features/config/ejectInteractive.js');

  it('should find item in menu', () => {
    const menu: Record<string, EjectMenuCategory> = {
      Pieces: {
        items: [{ name: 'default', type: 'piece', scope: 'local', description: 'Standard' }],
      },
    };

    const item = findItemInMenu(menu, 'default');
    expect(item).not.toBeNull();
    expect(item?.name).toBe('default');
  });

  it('should return null for non-existent item', () => {
    const menu: Record<string, EjectMenuCategory> = {
      Pieces: {
        items: [{ name: 'default', type: 'piece', scope: 'local', description: 'Standard' }],
      },
    };

    const item = findItemInMenu(menu, 'nonexistent');
    expect(item).toBeNull();
  });

  it('should find item in nested subcategories', () => {
    const menu: Record<string, EjectMenuCategory> = {
      Facets: {
        subcategories: {
          Personas: {
            items: [{ name: 'coder', type: 'facet', facet_type: 'personas', scope: 'local', description: 'Coder' }],
          },
        },
      },
    };

    const item = findItemInMenu(menu, 'coder');
    expect(item).not.toBeNull();
    expect(item?.name).toBe('coder');
    expect(item?.facet_type).toBe('personas');
  });
});

describe('findSubcategory', async () => {
  const { findSubcategory } = await import('../features/config/ejectInteractive.js');

  it('should find subcategory in menu', () => {
    const menu: Record<string, EjectMenuCategory> = {
      Pieces: {
        subcategories: {
          'Quick Start': {
            items: [{ name: 'default', type: 'piece', scope: 'local', description: 'Standard' }],
          },
        },
      },
    };

    const sub = findSubcategory(menu, 'Quick Start');
    expect(sub).not.toBeNull();
  });

  it('should return null for non-existent subcategory', () => {
    const menu: Record<string, EjectMenuCategory> = {
      Pieces: {
        subcategories: {
          'Quick Start': {
            items: [],
          },
        },
      },
    };

    const sub = findSubcategory(menu, 'NonExistent');
    expect(sub).toBeNull();
  });
});
