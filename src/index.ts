/**
 * cardless — A TypeScript tabletop card-state server framework.
 *
 * @module
 */

export { initProject } from "./init.ts";
export type { InitOptions } from "./init.ts";

export { runGame } from "./run.ts";
export type { RunOptions } from "./run.ts";

export { CardlessServer } from "./server.ts";
export type { ServedGame } from "./server.ts";
export { RoomManager } from "./room.ts";
export {
  moveCards,
  shufflePile,
  pickCards,
} from "./actions.ts";
export {
  createInitialG,
  createInitialCtx,
  createInitialState,
} from "./state.ts";
export {
  loadGameConfig,
  loadCardDefs,
  loadPileDefs,
  resolveGameDir,
  discoverGameProjects,
  loadGameLobbyMetadata,
} from "./loader.ts";

export type * from "./types.ts";
