#!/usr/bin/env node

import { Command } from "commander";
import { initProject } from "./init.ts";
import { runGame } from "./run.ts";

/**
 * cardless CLI entry-point.
 *
 * Commands:
 *   init <project-name|.>  — Scaffold a new cardless game project
 *   run  <project-name|.>  — Start a game server
 */
async function main() {
  const program = new Command();

  program
    .name("cardless")
    .description("A tabletop card-state server framework")
    .version("0.1.0");

  program
    .command("init")
    .argument("<target>", "Project name or '.' for the current directory")
    .description("Create a new cardless game project")
    .action(async (target: string) => {
      const cwd = process.cwd();
      try {
        await initProject({ target, cwd });
        const projectDir = target === "." ? cwd : `${cwd}/${target}`;
        console.log(`Created cardless game project at ${projectDir}`);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(message);
        process.exit(1);
      }
    });

  program
    .command("run")
    .argument("<target>", "Game directory or '.' for the current directory")
    .description("Start a game server")
    .option("-p, --port <number>", "Port to listen on", "3000")
    .option("-l, --locale <locale>", "Language pack to load, for example en or zh-CN")
    .option("-m, --multi", "Serve every game project directly inside the target directory")
    .action(async (target: string, opts: { port: string; locale?: string; multi?: boolean }) => {
      try {
        await runGame({
          target,
          cwd: process.cwd(),
          port: parseInt(opts.port, 10),
          locale: opts.locale,
          multi: opts.multi,
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(message);
        process.exit(1);
      }
    });

  await program.parseAsync(process.argv);
}

main();
