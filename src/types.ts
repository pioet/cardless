/**
 * Core types for cardless — a tabletop card-state server framework.
 *
 * Inspired by boardgame.io's state model:
 *   State = { G: gameState, ctx: contextualMetadata }
 */

// ── Card Definitions ──────────────────────────────────────────────────────

/** A card face definition loaded from card.csv */
export interface CardDef {
  /** Display name, e.g. "A ♥️", "🤡" */
  name: string;
  /** Optional category, e.g. "spade", "joker" */
  category?: string;
  /** Optional description */
  description?: string;
  /** Text shown in the top-left corner of the card face */
  corner?: string;
  /** Text shown in the centre of the card face */
  center?: string;
  /** Number of instances to create (default: 1) */
  count?: number;
}

// ── Card Instances ─────────────────────────────────────────────────────────

/** A unique card instance in a pile */
export interface Card {
  /** Unique instance id (e.g. "card-0", "card-1") */
  id: string;
  /** References a CardDef key (e.g. "A ♥️") */
  defId: string;
}

// ── Pile Definitions ───────────────────────────────────────────────────────

/** A pile (zone/area) definition loaded from pile.csv */
export interface PileDef {
  /** Pile name, e.g. "deck", "hand", "discard" */
  name: string;
  /** Visibility scope */
  area: "public" | "private";
  /** Whether cards are shown face-up */
  orientation: "up" | "down";
  /** Optional target category constraint; empty means any card category */
  category?: string;
}

// ── Game Config ────────────────────────────────────────────────────────────

/** A predefined custom action definition from game.toml */
export interface CustomActionDef {
  method: "top" | "random";
  count: number;
}

/** Parsed game.toml */
export interface GameConfig {
  /** Optional version of this game configuration package. */
  version?: string;
  /** Optional name of the person or team that edited this configuration. */
  editor?: string;
  /** Optional free-form note from the configuration editor. */
  comment?: string;
  /** Active locale code when this configuration was loaded from a language pack. */
  locale?: string;
  name: string;
  /** Optional player-facing help text. Supports escaped "\n" line breaks. */
  help?: string;
  max_players: number;
  card: string;
  pile: string;
  /** Optional predefined custom actions (shown to all players) */
  customActions?: CustomActionDef[];
}

// ── Game State (boardgame.io style) ────────────────────────────────────────

/**
 * The game-specific state.
 * Cards are stored flat; piles reference card IDs by order.
 */
export interface G {
  /** Card definitions keyed by defId (card name) */
  cardDefs: Record<string, CardDef>;
  /** All card instances keyed by card ID */
  cards: Record<string, Card>;
  /**
   * Pile contents keyed by pile name.
   * For private piles (scope="player"), keys are "pileName:playerId".
   */
  piles: Record<string, string[]>;
  /** Pile definitions (metadata) */
  pileDefs: Record<string, PileDef>;
}

/**
 * Context metadata — boardgame.io inspired.
 *
 * Since cardless does NOT implement game logic, most fields are
 * informational only. The framework does not enforce turn order
 * or phase transitions — players self-govern.
 */
export interface Ctx {
  /** Number of players in the room */
  numPlayers: number;
  /** Ordered list of player IDs */
  playOrder: string[];
  /** Current position in playOrder (always 0 for cardless) */
  playOrderPos: number;
  /** Which players can act — null means all */
  activePlayers: null | Record<string, { stage?: string }>;
  /** The "current" player (informational only) */
  currentPlayer: string;
  /** Incremented on each move */
  turn: number;
  /** Game phase — always "play" for cardless */
  phase: string;
}

/** Complete state sent to clients (subset of boardgame.io State) */
export interface State {
  G: G;
  ctx: Ctx;
}

/** Incremental state update sent after one card or pile operation. */
export interface StateDelta {
  turn: number;
  piles: Record<string, string[]>;
  entry: HistoryEntry;
}

// ── Player info ────────────────────────────────────────────────────────────

export interface Player {
  id: string;
  name: string;
}

// ── Room ───────────────────────────────────────────────────────────────────

export interface Room {
  /** Unique room code */
  code: string;
  /** Loaded game config */
  config: GameConfig;
  /** Game directory path */
  gameDir: string;
  /** Identifier of the served game project. */
  gameId: string;
  /** Connected players */
  players: Player[];
  /** Game state — set when the game starts */
  state: State | null;
  /** Owner (creator) player ID */
  ownerId: string;
}

// ── WebSocket Messages ────────────────────────────────────────────────────

export type ClientMessage =
  | { type: "join"; room: string; playerName: string }
  | { type: "create"; playerName: string; gameId?: string }
  | { type: "resume"; room: string; playerId: string; resumeToken: string }
  | { type: "sync" }
  | { type: "start" }
  | { type: "move"; action: MoveAction }
  | { type: "select"; cardIds: string[] }
  | { type: "shuffle"; pile: string }
  | { type: "sort"; pile: string };

export type ServerMessage =
  | { type: "room_joined"; room: string; playerId: string; resumeToken: string; gameId: string; players: Player[]; gameName: string; gameHelp?: string; customActions?: CustomActionDef[] }
  | { type: "room_created"; room: string; playerId: string; resumeToken: string; gameId: string; gameName: string; gameHelp?: string; customActions?: CustomActionDef[] }
  | { type: "room_resumed"; room: string; playerId: string; gameId: string; players: Player[]; gameName: string; gameHelp?: string; customActions?: CustomActionDef[] }
  | { type: "players_updated"; players: Player[] }
  | { type: "game_started"; state: State; playerId: string; gameId: string; entries: HistoryEntry[]; gameName: string; gameHelp?: string; customActions?: CustomActionDef[] }
  | { type: "game_resumed"; state: State; playerId: string; gameId: string; players: Player[]; entries: HistoryEntry[]; gameName: string; gameHelp?: string; customActions?: CustomActionDef[] }
  | { type: "state_delta"; delta: StateDelta; playerId: string; gameId: string; gameName: string; gameHelp?: string; customActions?: CustomActionDef[] }
  | { type: "state_updated"; state: State; playerId: string; gameId: string; entries: HistoryEntry[]; gameName: string; gameHelp?: string; customActions?: CustomActionDef[] }
  | { type: "error"; message: string }
  | { type: "history"; entries: HistoryEntry[] };

// ── Actions / Moves ───────────────────────────────────────────────────────

/** A move describes a card operation performed by a player */
export interface MoveAction {
  /** Source pile name (without player suffix) */
  from: string;
  /** Target pile name (without player suffix) */
  to: string;
  /** Card instance IDs to move */
  cardIds: string[];
  /** Player performing the move */
  playerId: string;
  /** Optional client pick mode used before the move, e.g. "top" or "random" */
  pickMethod?: "top" | "random" | "all";
}

/** A history entry records a completed move */
export interface HistoryEntry {
  timestamp: number;
  /** Player ID that created the history entry; omitted for system actions. */
  playerId?: string;
  playerName: string;
  action: string;
  detail: string;
  /** Whether this action touched at least one public pile. */
  isPublicAction?: boolean;
}
