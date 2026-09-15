/**
 * Loads and parses game configuration files (game.toml, card.csv, pile.csv)
 * from a game project directory.
 */

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { CardDef, CustomActionDef, GameConfig, PileDef } from "./types.ts";

/** Parsed definitions are immutable and can be shared by rooms of one game. */
const cardDefCache = new Map<string, Promise<Record<string, CardDef>>>();
const pileDefCache = new Map<string, Promise<Record<string, PileDef>>>();

/** A game project available from a multi-game root directory. */
export interface GameProject {
  /** Stable identifier used by the client and asset routes. */
  id: string;
  /** Absolute path to the game project directory. */
  gameDir: string;
}

/**
 * Discover game projects immediately inside a multi-game root directory.
 * A child is considered a game only when it contains game.toml.
 */
export async function discoverGameProjects(target: string, cwd: string): Promise<GameProject[]> {
  const root = target === "." ? cwd : path.resolve(cwd, target);
  const entries = await readdir(root, { withFileTypes: true });
  const projects: GameProject[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const gameDir = path.join(root, entry.name);
    try {
      await readFile(path.join(gameDir, "game.toml"), "utf8");
      projects.push({ id: entry.name, gameDir });
    } catch {
      // Directories without game.toml are not game projects.
    }
  }

  if (projects.length === 0) {
    throw new Error(`Could not find any game projects inside "${target}".`);
  }

  return projects.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Resolve the game directory from a target path.
 * If target is ".", use cwd. Otherwise resolve relative to cwd.
 * Also checks for a "games/<name>" pattern relative to cwd.
 */
export async function resolveGameDir(target: string, cwd: string): Promise<string> {
  // Try direct path first
  let dir = target === "." ? cwd : path.resolve(cwd, target);

  // Check if game.toml exists in this directory
  try {
    await readFile(path.join(dir, "game.toml"), "utf8");
    return dir;
  } catch {
    // Not found, try as a name inside cwd
  }

  // Try cwd/<target> as a subdirectory
  dir = path.resolve(cwd, target);
  try {
    await readFile(path.join(dir, "game.toml"), "utf8");
    return dir;
  } catch {
    // Not found either
  }

  // Try cwd/games/<target>
  dir = path.resolve(cwd, "games", target);
  try {
    await readFile(path.join(dir, "game.toml"), "utf8");
    return dir;
  } catch {
    throw new Error(
      `Could not find a cardless game project at "${target}". ` +
        `Ensure game.toml exists in the target directory.`,
    );
  }
}

/**
 * Parse a TOML-like config file.
 * This is a minimal parser for the subset of TOML that cardless uses:
 *   key = "value"
 *   key = 123
 *   [[custom_actions]]
 *     method = "top"
 *     count = 17
 * Comments start with #
 */
interface ParsedToml {
  fields: Record<string, string | number>;
  /** Array tables found, keyed by the array name */
  arrayTables: Record<string, Record<string, string | number>[]>;
}

function parseToml(text: string): ParsedToml {
  const fields: Record<string, string | number> = {};
  const arrayTables: Record<string, Record<string, string | number>[]> = {};
  let currentArray: string | null = null;

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    // Detect [[array_table]] header
    const arrayHeaderMatch = trimmed.match(/^\[\[(\w+)\]\]$/);
    if (arrayHeaderMatch) {
      currentArray = arrayHeaderMatch[1];
      if (!arrayTables[currentArray]) {
        arrayTables[currentArray] = [];
      }
      // Push a new empty record for each [[header]] occurrence
      arrayTables[currentArray].push({});
      continue;
    }

    const match = trimmed.match(/^(\w+)\s*=\s*(.+)$/);
    if (!match) continue;

    const [, key, raw] = match;
    const val = raw.trim();
    let parsedValue: string | number;
    if (val.startsWith('"') && val.endsWith('"')) {
      parsedValue = val.slice(1, -1).replace(/\\n/g, "\n").replace(/\\"/g, '"');
    } else {
      parsedValue = Number(val);
    }

    if (currentArray) {
      // Inside an array table, push a new record
      const last = arrayTables[currentArray]![arrayTables[currentArray]!.length - 1];
      if (last) {
        last[key] = parsedValue;
      }
    } else {
      fields[key] = parsedValue;
    }
  }

  return { fields, arrayTables };
}

/**
 * Parse a CSV file with a header row.
 * Returns an array of records keyed by header names.
 */
function parseCsv<T extends Record<string, string>>(text: string): T[] {
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  if (lines.length < 1) return [];

  // Parse the header row — handle quoted commas
  const headers = parseCsvRow(lines[0]);
  const result: T[] = [];

  for (let i = 1; i < lines.length; i++) {
    const fields = parseCsvRow(lines[i]);
    if (fields.length === 0) continue;
    const record: Record<string, string> = {};
    headers.forEach((h, idx) => {
      record[h] = fields[idx] ?? "";
    });
    result.push(record as unknown as T);
  }

  return result;
}

/** Parse a single CSV row, respecting quoted fields */
function parseCsvRow(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      fields.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current.trim());
  return fields;
}

/**
 * Load game metadata and, when requested, overlay one language pack.
 *
 * Language packs live at `locales/<locale>/game.toml` and may override
 * player-facing fields such as name, help, card, and pile. Shared game settings
 * remain in the root game.toml so images and game rules are not duplicated per
 * language.
 */
export async function loadGameConfig(gameDir: string, locale?: string): Promise<GameConfig> {
  const { baseConfig, fields, activeLocale } = await loadGameFields(gameDir, locale);

  const name = requireGameName(fields);
  const max_players = Number(fields.max_players ?? 4);
  const card = String(fields.card ?? "card.csv");
  const pile = String(fields.pile ?? "pile.csv");

  // Help: if value ends with ".txt", read from that file; otherwise use inline string
  let help: string | undefined;
  const rawHelp = fields.help;
  if (rawHelp !== undefined && rawHelp !== null) {
    const helpStr = String(rawHelp);
    if (helpStr.endsWith(".txt")) {
      // Read from external file relative to game directory
      try {
        help = await readFile(path.join(gameDir, helpStr), "utf8");
      } catch {
        throw new Error(
          `game.toml: help = "${helpStr}" file not found in game directory. ` +
          `Expected ${path.join(gameDir, helpStr)} to exist.`
        );
      }
    } else {
      help = helpStr;
    }
  }

  // Parse [[custom_actions]] array table
  let customActions: CustomActionDef[] | undefined;
  const rawActions = baseConfig.arrayTables["custom_actions"];
  if (rawActions && rawActions.length > 0) {
    customActions = [];
    for (const item of rawActions) {
      const method = String(item.method ?? "");
      const count = Number(item.count ?? 1);
      if (method !== "top" && method !== "random") {
        throw new Error(
          `game.toml [[custom_actions]]: method must be "top" or "random", got "${method}"`
        );
      }
      if (!Number.isInteger(count) || count < 1) {
        throw new Error(
          `game.toml [[custom_actions]]: count must be a positive integer, got ${count}`
        );
      }
      customActions.push({ method: method as "top" | "random", count });
    }
  }

  return {
    version: optionalStringField(fields.version),
    editor: optionalStringField(fields.editor),
    comment: optionalStringField(fields.comment),
    locale: activeLocale,
    name,
    help,
    max_players,
    card,
    pile,
    customActions,
  };
}

/** Load only the display name needed to render the lobby game picker. */
export async function loadGameLobbyMetadata(gameDir: string, locale?: string): Promise<{ name: string }> {
  const { fields } = await loadGameFields(gameDir, locale);
  return { name: requireGameName(fields) };
}

/** Read and merge the small TOML files without loading help or card data. */
async function loadGameFields(gameDir: string, locale?: string): Promise<{
  baseConfig: ParsedToml;
  fields: Record<string, string | number>;
  activeLocale?: string;
}> {
  const raw = await readFile(path.join(gameDir, "game.toml"), "utf8");
  const baseConfig = parseToml(raw);
  let fields = baseConfig.fields;
  const activeLocale = locale || optionalStringField(fields.default_locale);

  if (activeLocale) {
    validateLocale(activeLocale);
    const localePath = path.join(gameDir, "locales", activeLocale, "game.toml");
    let localeConfig: ParsedToml;
    try {
      localeConfig = parseToml(await readFile(localePath, "utf8"));
    } catch {
      throw new Error(`Language pack "${activeLocale}" was not found at ${localePath}`);
    }
    fields = { ...fields, ...localeConfig.fields };
  }
  return { baseConfig, fields, activeLocale };
}

/** Return the required display name from parsed game fields. */
function requireGameName(fields: Record<string, string | number>): string {
  const name = String(fields.name ?? "");
  if (!name) throw new Error(`game.toml is missing required field "name"`);
  return name;
}

/** Return an optional scalar string without treating empty values as present. */
function optionalStringField(value: string | number | undefined): string | undefined {
  const text = stringField(value);
  return text || undefined;
}

/** Convert a parsed scalar to a trimmed string. */
function stringField(value: string | number | undefined): string {
  return value === undefined ? "" : String(value).trim();
}

/** Restrict locale file names to simple BCP 47-style identifiers. */
function validateLocale(locale: string): void {
  if (!/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/.test(locale)) {
    throw new Error(`Invalid locale "${locale}"`);
  }
}

/** Load and parse card.csv from a game directory */
export function loadCardDefs(gameDir: string, filename: string): Promise<Record<string, CardDef>> {
  const key = path.resolve(gameDir, filename);
  const cached = cardDefCache.get(key);
  if (cached) return cached;
  const loading = loadCardDefsUncached(gameDir, filename);
  cardDefCache.set(key, loading);
  return loading;
}

async function loadCardDefsUncached(gameDir: string, filename: string): Promise<Record<string, CardDef>> {
  const raw = await readFile(path.join(gameDir, filename), "utf8");
  const rows = parseCsv(raw);

  const defs: Record<string, CardDef> = {};

  /**
   * Merge a parsed row into the defs map.
   * Supports two approaches for multiple copies:
   *   1. An explicit `count` column (e.g. count=50).
   *   2. Duplicate rows with the same name — each occurrence increments count.
   */
  for (const row of rows) {
    const name = row.name || "Unnamed";

    // Parse explicit count from the row, defaulting to 1
    const explicitCount = row.count ? parseInt(row.count, 10) : 0;

    if (defs[name]) {
      // Merge into existing def: increment count
      defs[name].count = (defs[name].count ?? 1) + (explicitCount || 1);
    } else {
      defs[name] = {
        name,
        category: row.category || undefined,
        description: row.description || undefined,
        corner: row.corner || undefined,
        center: row.center || undefined,
        count: explicitCount || 1,
      };
    }
  }

  return defs;
}

/** Load and parse pile.csv from a game directory */
export function loadPileDefs(gameDir: string, filename: string): Promise<Record<string, PileDef>> {
  const key = path.resolve(gameDir, filename);
  const cached = pileDefCache.get(key);
  if (cached) return cached;
  const loading = loadPileDefsUncached(gameDir, filename);
  pileDefCache.set(key, loading);
  return loading;
}

async function loadPileDefsUncached(gameDir: string, filename: string): Promise<Record<string, PileDef>> {
  const raw = await readFile(path.join(gameDir, filename), "utf8");
  const rows = parseCsv(raw);

  const defs: Record<string, PileDef> = {};
  for (const row of rows) {
    const name = row.name || "unnamed";
    const area = (row.area || "public") as "public" | "private";
    const orientation = (row.orientation || "down") as "up" | "down";
    defs[name] = { name, area, orientation, category: row.category || undefined };
  }

  return defs;
}
