#!/usr/bin/env node
/**
 * Generate hybrid-codex piece variants from standard pieces.
 *
 * For each standard piece (not already -hybrid-codex, not in skip list):
 *   1. Parse the YAML
 *   2. Set `provider: codex` on the coder persona definition
 *   3. Change name to {name}-hybrid-codex
 *   4. Write the hybrid-codex YAML file
 *   5. Update piece-categories.yaml to include generated hybrids
 *
 * Usage:
 *   node tools/generate-hybrid-codex.mjs            # Generate all
 *   node tools/generate-hybrid-codex.mjs --dry-run   # Preview only
 */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { parse, stringify } from 'yaml';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const BUILTINS = join(ROOT, 'builtins');
const LANGUAGES = ['en', 'ja'];

/** Pieces that should NOT get hybrid variants (no coder involvement or special purpose) */
const SKIP_PIECES = new Set(['magi', 'research', 'review-only']);

const CODER_PERSONA = 'coder';
const dryRun = process.argv.includes('--dry-run');

// ─────────────────────────────────────────
// Persona transformation
// ─────────────────────────────────────────

function hasCoderPersona(movement) {
  if (movement.persona === CODER_PERSONA) return true;
  if (movement.parallel) return movement.parallel.some(sub => sub.persona === CODER_PERSONA);
  return false;
}

/**
 * Set `provider: codex` on the coder persona in the personas section.
 * Converts coder persona from string format to object format with provider.
 */
function addCodexToCoderPersona(personas) {
  if (!personas) return personas;
  const result = {};
  for (const [name, value] of Object.entries(personas)) {
    if (name === CODER_PERSONA) {
      const path = typeof value === 'string' ? value : value.path;
      result[name] = { path, provider: 'codex' };
    } else {
      result[name] = value;
    }
  }
  return result;
}

// ─────────────────────────────────────────
// Hybrid piece builder
// ─────────────────────────────────────────

/** Top-level field order for readable output */
const TOP_FIELD_ORDER = [
  'name', 'description', 'max_iterations',
  'stances', 'knowledge', 'personas', 'instructions', 'report_formats',
  'initial_movement', 'loop_monitors', 'answer_agent', 'movements',
];

function buildHybrid(parsed) {
  const hybrid = {};
  for (const field of TOP_FIELD_ORDER) {
    if (field === 'name') {
      hybrid.name = `${parsed.name}-hybrid-codex`;
    } else if (field === 'personas') {
      hybrid.personas = addCodexToCoderPersona(parsed.personas);
    } else if (parsed[field] != null) {
      hybrid[field] = parsed[field];
    }
  }
  // Carry over any extra top-level fields not in the order list
  for (const key of Object.keys(parsed)) {
    if (!(key in hybrid) && key !== 'name') {
      hybrid[key] = parsed[key];
    }
  }
  return hybrid;
}

function generateHeader(sourceFile) {
  return [
    `# Auto-generated from ${sourceFile} by tools/generate-hybrid-codex.mjs`,
    '# Do not edit manually. Edit the source piece and re-run the generator.',
    '',
    '',
  ].join('\n');
}

// ─────────────────────────────────────────
// Category handling
// ─────────────────────────────────────────

/** Recursively collect all piece names from a category tree */
function collectPieces(obj) {
  const pieces = [];
  if (!obj || typeof obj !== 'object') return pieces;
  if (Array.isArray(obj.pieces)) pieces.push(...obj.pieces);
  for (const [key, val] of Object.entries(obj)) {
    if (key === 'pieces') continue;
    if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
      pieces.push(...collectPieces(val));
    }
  }
  return pieces;
}

/** Find the key for the hybrid top-level category */
function findHybridTopKey(categories) {
  for (const key of Object.keys(categories)) {
    if (key.includes('Hybrid') || key.includes('ハイブリッド')) return key;
  }
  return null;
}

/**
 * Build mapping: standard piece name → top-level category key.
 * Excludes the hybrid category and "Others" category.
 */
function getTopLevelMapping(categories, hybridKey, othersKey) {
  const map = new Map();
  for (const [key, val] of Object.entries(categories)) {
    if (key === hybridKey) continue;
    if (othersKey && key === othersKey) continue;
    if (typeof val !== 'object' || val === null) continue;
    const pieces = collectPieces(val);
    for (const p of pieces) map.set(p, key);
  }
  return map;
}

/**
 * Build the hybrid category section by mirroring standard categories.
 */
function buildHybridCategories(generatedNames, topMap) {
  // Group hybrids by their source piece's top-level category
  const grouped = new Map();
  for (const hybridName of generatedNames) {
    const sourceName = hybridName.replace('-hybrid-codex', '');
    const topCat = topMap.get(sourceName);
    if (!topCat) continue;
    if (!grouped.has(topCat)) grouped.set(topCat, []);
    grouped.get(topCat).push(hybridName);
  }

  const section = {};
  for (const [catKey, hybrids] of grouped) {
    section[catKey] = { pieces: hybrids.sort() };
  }
  return section;
}

// ─────────────────────────────────────────
// Main
// ─────────────────────────────────────────

console.log('=== Generating hybrid-codex pieces ===\n');

for (const lang of LANGUAGES) {
  console.log(`[${lang}]`);
  const generatedNames = [];

  const piecesDir = join(BUILTINS, lang, 'pieces');
  const files = readdirSync(piecesDir)
    .filter(f => f.endsWith('.yaml') && !f.includes('-hybrid-codex'))
    .sort();

  for (const file of files) {
    const name = basename(file, '.yaml');
    if (SKIP_PIECES.has(name)) {
      console.log(`  Skip: ${name} (in skip list)`);
      continue;
    }

    const content = readFileSync(join(piecesDir, file), 'utf-8');
    const parsed = parse(content);

    if (!parsed.movements?.some(hasCoderPersona)) {
      console.log(`  Skip: ${name} (no coder movements)`);
      continue;
    }

    const hybrid = buildHybrid(parsed);
    const header = generateHeader(file);
    const yamlOutput = stringify(hybrid, { lineWidth: 120, indent: 2 });
    const outputPath = join(piecesDir, `${name}-hybrid-codex.yaml`);

    if (dryRun) {
      console.log(`  Would generate: ${name}-hybrid-codex.yaml`);
    } else {
      writeFileSync(outputPath, header + yamlOutput, 'utf-8');
      console.log(`  Generated: ${name}-hybrid-codex.yaml`);
    }

    generatedNames.push(`${name}-hybrid-codex`);
  }

  // ─── Update piece-categories.yaml ───
  const catPath = join(BUILTINS, lang, 'piece-categories.yaml');
  const catRaw = readFileSync(catPath, 'utf-8');
  const catParsed = parse(catRaw);
  const cats = catParsed.piece_categories;

  if (cats) {
    const hybridKey = findHybridTopKey(cats);
    const othersKey = Object.keys(cats).find(k =>
      k === 'Others' || k === 'その他'
    );

    if (hybridKey) {
      const topMap = getTopLevelMapping(cats, hybridKey, othersKey);
      const newSection = buildHybridCategories(generatedNames, topMap);
      cats[hybridKey] = newSection;

      if (dryRun) {
        console.log(`  Would update: piece-categories.yaml`);
        console.log(`    Hybrid pieces: ${generatedNames.join(', ')}`);
      } else {
        const catOut = stringify(catParsed, { lineWidth: 120, indent: 2 });
        writeFileSync(catPath, catOut, 'utf-8');
        console.log(`  Updated: piece-categories.yaml`);
      }
    } else {
      console.log(`  Warning: No hybrid category found in piece-categories.yaml`);
    }
  }

  console.log();
}

console.log('Done!');
if (dryRun) console.log('(dry-run mode, no files were written)');
