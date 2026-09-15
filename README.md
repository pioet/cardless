# cardless

A TypeScript tabletop card-state server framework. Define your cards and piles, then play
with friends over the local network — no physical deck, no code.

cardless handles shuffling, drawing, moving cards, and keeping each player's hand private.
It does **not** enforce rules, turns, or turn order — you and your friends run the game
yourselves at the table.

## Requirements

- Node.js >= 24 (the CLI runs TypeScript directly via native type stripping)
- pnpm

## Install

```bash
pnpm install
```

## Run a game

Start the server for one of the bundled example games (or your own project):

```bash
pnpm cardless run games/coup-zh
```

The terminal prints a **Local** URL (`http://localhost:3000`) and a **Share** URL for your
LAN. Open the local URL yourself, and share the LAN URL so other players can join from their
own phones or laptops.

Useful options:

```bash
pnpm cardless run <project> --port 8080      # change the listening port
pnpm cardless run <project> --locale zh-CN   # load a language pack
pnpm cardless run games --multi              # serve every game inside a directory
```

## Create your own game

Scaffold a new project, then fill in the generated files:

```bash
pnpm cardless init my-game
```

This creates:

- `game.toml` — game name, player limits, and references to the card/pile files
- `card.csv` — every card face in the game
- `pile.csv` — the piles (areas) cards can be placed into
- `help.txt` — the rules text shown to players

Then run it with `pnpm cardless run my-game`. See `specs/core/init.md` for the full format,
and the projects under `games/` for working examples.

## Development

```bash
pnpm test        # run the test suite
pnpm typecheck   # type-check without emitting
```

## Project layout

```
src/cli.ts     # command-line entry point (init / run)
src/init.ts    # project scaffolding
src/loader.ts  # reads game.toml, card.csv, pile.csv
src/server.ts  # HTTP + WebSocket game server
src/room.ts    # room, player, and card-state management
src/client/    # browser UI
games/         # example game projects
specs/         # format and UI specifications
```
