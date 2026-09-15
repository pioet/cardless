/**
 * `cardless run` — starts a game server for a cardless game project.
 *
 * Usage: cardless run <target>
 *   target  — path to a game directory (e.g. "games/landlord", ".", "coup")
 */

import os from "node:os";
import { discoverGameProjects, loadGameLobbyMetadata, resolveGameDir } from "./loader.ts";
import { CardlessServer, type ServedGame } from "./server.ts";

export interface RunOptions {
  target: string;
  cwd: string;
  port?: number;
  /** Optional language-pack identifier, for example "en" or "zh-CN". */
  locale?: string;
  /** Discover and serve all game projects directly inside target. */
  multi?: boolean;
}

/**
 * Start a cardless game server.
 */
export async function runGame(options: RunOptions): Promise<void> {
  const port = options.port ?? 3000;
  const games: ServedGame[] = options.multi
    ? await discoverGameProjects(options.target, options.cwd)
    : [{ id: "default", gameDir: await resolveGameDir(options.target, options.cwd) }];
  const metadata = await loadGameLobbyMetadata(games[0]!.gameDir, options.locale);

  const server = new CardlessServer(games, options.locale);
  await server.start(port);

  printRunSummary({
    gameName: metadata.name,
    gameCount: games.length,
    port,
    lanUrl: getLanUrls(port)[0],
  });
}

interface RunSummaryOptions {
  gameName: string;
  gameCount: number;
  port: number;
  lanUrl?: string;
}

/**
 * Print an action-oriented startup summary without terminal noise.
 * ANSI styling is limited to interactive terminals so redirected logs remain plain text.
 */
function printRunSummary(options: RunSummaryOptions): void {
  const localUrl = `http://localhost:${options.port}`;
  const color = createTerminalColor();
  const lines = [
    `${color.green("✓")} ${color.bold("Game ready")}`,
    `${color.dim(options.gameCount === 1 ? "Game " : "Games")} ${options.gameCount === 1 ? options.gameName : `${options.gameCount} available`}`,
    `${color.dim("Local")} ${color.cyan(localUrl)}`,
  ];

  if (options.lanUrl) {
    lines.push(`${color.dim("Share")} ${color.cyan(options.lanUrl)}`);
  }

  console.log(`\n${lines.join("\n")}\n`);
}

/** Build TTY-safe ANSI helpers while keeping non-interactive logs readable. */
function createTerminalColor() {
  const enabled = Boolean(process.stdout.isTTY && !process.env.NO_COLOR);
  const wrap = (code: number) => (text: string) => enabled ? `\u001B[${code}m${text}\u001B[0m` : text;
  return { bold: wrap(1), dim: wrap(2), green: wrap(32), cyan: wrap(36) };
}

/**
 * Return browser URLs for active local-network IPv4 addresses.
 */
function getLanUrls(port: number): string[] {
  const urls: string[] = [];
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== "IPv4" || address.internal) continue;
      urls.push(`http://${address.address}:${port}`);
    }
  }
  return urls;
}
