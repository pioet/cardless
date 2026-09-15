import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

export interface InitOptions {
  /** Target directory name (or "." for current) */
  target: string;
  /** Working directory where the target should be created */
  cwd: string;
}

/**
 * Initialize a new cardless game project in the target directory.
 *
 * Creates the following files:
 *   game.toml  — Game metadata (name, player limits, references to card/pile files)
 *   card.csv   — Card definitions (CSV format)
 *   pile.csv   — Pile (area) definitions (CSV format)
 *
 * If target is ".", the current directory itself is used and its basename
 * becomes the game name.
 */
export async function initProject(options: InitOptions): Promise<void> {
  const projectDir =
    options.target === "." ? options.cwd : path.resolve(options.cwd, options.target);

  // Derive a display name from the directory name.
  const dirName = path.basename(projectDir);
  const gameName = dirName
    .split(/[-_\s]+/)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(" ");

  // Create the project directory if it doesn't exist.
  await mkdir(projectDir, { recursive: true });

  // Ensure the target directory is empty (only allow empty dirs).
  const entries = await readdir(projectDir);
  const visible = entries.filter((e) => !e.startsWith("."));
  if (visible.length > 0) {
    throw new Error(
      `Target directory is not empty: ${projectDir} (entries: ${visible.join(", ")})`,
    );
  }

  // ── help.txt ──────────────────────────────────────────────────────────
  const helpTxt = `Describe how to play ${gameName} here.
Use multiple lines to explain the rules.

Each paragraph can be as long or short as needed.
`;

  // ── game.toml ──────────────────────────────────────────────────────────
  const gameToml = [
    `name = "${gameName}"`,
    `version = "0.1.0"`,
    `# editor = "Your name or team"`,
    `# comment = "Optional editor note or project URL"`,
    `max_players = 4`,
    `card = "card.csv"`,
    `pile = "pile.csv"`,
    `help = "help.txt"`,
    "",
  ].join("\n");

  // ── card.csv ───────────────────────────────────────────────────────────
  // count column: number of copies of this card (default: 1)
  const cardCsv = [
    "name,category,description,corner,center,count",
    '"Card1",,,,,1',
    '"Card2",,,,,1',
    "",
  ].join("\n");

  // ── pile.csv ───────────────────────────────────────────────────────────
  const pileCsv = [
    "name,area,orientation,category",
    "deck,public,down,",
    "discard,public,up,",
    "hand,private,down,",
    "",
  ].join("\n");

  // Write all files in parallel.
  await Promise.all([
    writeFile(path.join(projectDir, "game.toml"), gameToml, "utf8"),
    writeFile(path.join(projectDir, "card.csv"), cardCsv, "utf8"),
    writeFile(path.join(projectDir, "pile.csv"), pileCsv, "utf8"),
    writeFile(path.join(projectDir, "help.txt"), helpTxt, "utf8"),
  ]);
}
