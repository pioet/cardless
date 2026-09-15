/**
 * Room manager — handles room creation, joining, and game lifecycle.
 *
 * Each room is identified by a short alphanumeric room code.
 * The server maintains a map of room codes to Room objects.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Room, Player, State, StateDelta, HistoryEntry, MoveAction } from "./types.ts";
import { loadGameConfig, resolveGameDir } from "./loader.ts";
import { createInitialState } from "./state.ts";
import { moveCards, shufflePile, sortPile } from "./actions.ts";

// Generate a random 4-character room code (uppercase, no confusable chars)
function generateRoomCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 4; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

// Generate a short player ID
function generatePlayerId(): string {
  return "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
}

export class RoomManager {
  private rooms: Map<string, Room> = new Map();
  private history: Map<string, HistoryEntry[]> = new Map();
  /** Player-specific recovery tokens, kept separate from public room data. */
  private playerTokens: Map<string, Map<string, string>> = new Map();

  /**
   * Create a new room for a game project.
   * Returns the room code and the creator's player ID.
   */
  async createRoom(gameDir: string, gameId: string, playerName: string, locale?: string): Promise<{ room: string; playerId: string; resumeToken: string }> {
    const config = await loadGameConfig(gameDir, locale);
    const roomCode = this.generateUniqueCode();
    const playerId = generatePlayerId();

    const room: Room = {
      code: roomCode,
      config,
      gameDir,
      gameId,
      players: [{ id: playerId, name: playerName }],
      state: null,
      ownerId: playerId,
    };

    this.rooms.set(roomCode, room);
    this.history.set(roomCode, []);
    const resumeToken = createResumeToken();
    this.playerTokens.set(roomCode, new Map([[playerId, resumeToken]]));

    return { room: roomCode, playerId, resumeToken };
  }

  /**
   * Join an existing room.
   */
  joinRoom(roomCode: string, playerName: string): { room: string; playerId: string; resumeToken: string; players: Player[] } {
    const room = this.rooms.get(roomCode);
    if (!room) {
      throw new Error(`Room "${roomCode}" not found`);
    }
    if (room.players.length >= room.config.max_players) {
      throw new Error(`Room "${roomCode}" is full (max ${room.config.max_players} players)`);
    }
    if (room.state) {
      throw new Error(`Game has already started in room "${roomCode}"`);
    }

    const playerId = generatePlayerId();
    room.players.push({ id: playerId, name: playerName });
    const resumeToken = createResumeToken();
    this.playerTokens.get(roomCode)?.set(playerId, resumeToken);

    return { room: roomCode, playerId, resumeToken, players: room.players };
  }

  /**
   * Verify a player's recovery token and return the existing room session.
   * Recovery never creates a player, so it also works after the game starts.
   */
  resumeRoom(roomCode: string, playerId: string, resumeToken: string): Room {
    const room = this.rooms.get(roomCode);
    const expectedToken = this.playerTokens.get(roomCode)?.get(playerId);
    if (!room || !expectedToken || !tokensMatch(expectedToken, resumeToken)) {
      throw new Error("Unable to restore the previous game session");
    }
    return room;
  }

  /**
   * Start the game in a room (creator only).
   */
  async startGame(roomCode: string, playerId: string): Promise<State> {
    const room = this.rooms.get(roomCode);
    if (!room) throw new Error(`Room "${roomCode}" not found`);
    if (room.ownerId !== playerId) throw new Error("Only the room owner can start the game");
    if (room.state) throw new Error("Game already started");

    const state = await createInitialState(room.gameDir, room.config, room.players);
    room.state = state;
    return state;
  }

  /** Remove all in-memory data associated with an empty room. */
  deleteRoom(roomCode: string): void {
    this.rooms.delete(roomCode);
    this.history.delete(roomCode);
    this.playerTokens.delete(roomCode);
  }

  /**
   * Process a move action in a room.
   */
  processMove(
    roomCode: string,
    playerId: string,
    from: string,
    to: string,
    cardIds: string[],
    pickMethod?: MoveAction["pickMethod"],
  ): { entry: HistoryEntry; changedPiles: string[] } {
    const room = this.rooms.get(roomCode);
    if (!room) throw new Error(`Room "${roomCode}" not found`);
    if (!room.state) throw new Error("Game not started");

    const player = room.players.find((p) => p.id === playerId);
    if (!player) throw new Error(`Player "${playerId}" not in room`);

    const entry = moveCards(room.state.G, { from, to, cardIds, playerId, pickMethod }, room.players);

    // Increment turn
    room.state.ctx.turn++;

    const history = this.history.get(roomCode) ?? [];
    history.push(entry);
    this.history.set(roomCode, history.slice(-20));

    return { entry, changedPiles: [resolveRoomPileKey(room.state.G, from, playerId), resolveRoomPileKey(room.state.G, to, playerId)] };
  }

  /**
   * Process a shuffle action in a room.
   */
  processShuffle(roomCode: string, pileName: string, playerId?: string): { entry: HistoryEntry; changedPiles: string[] } {
    const room = this.rooms.get(roomCode);
    if (!room) throw new Error(`Room "${roomCode}" not found`);
    if (!room.state) throw new Error("Game not started");

    // Resolve player name
    let playerName: string | undefined;
    if (playerId) {
      const player = room.players.find((p) => p.id === playerId);
      playerName = player?.name;
    }

    const entry = shufflePile(room.state.G, pileName, playerName, playerId);

    // Increment turn
    room.state.ctx.turn++;

    const history = this.history.get(roomCode) ?? [];
    history.push(entry);
    this.history.set(roomCode, history.slice(-20));

    return { entry, changedPiles: [resolveRoomPileKey(room.state.G, pileName, playerId ?? "")] };
  }

  /**
   * Process a sort action in a room.
   */
  processSort(roomCode: string, pileName: string, playerId?: string): { entry: HistoryEntry; changedPiles: string[] } {
    const room = this.rooms.get(roomCode);
    if (!room) throw new Error(`Room "${roomCode}" not found`);
    if (!room.state) throw new Error("Game not started");

    // Resolve player name
    let playerName: string | undefined;
    if (playerId) {
      const player = room.players.find((p) => p.id === playerId);
      playerName = player?.name;
    }

    const entry = sortPile(room.state.G, pileName, playerName, playerId);

    // Increment turn
    room.state.ctx.turn++;

    const history = this.history.get(roomCode) ?? [];
    history.push(entry);
    this.history.set(roomCode, history.slice(-20));

    return { entry, changedPiles: [resolveRoomPileKey(room.state.G, pileName, playerId ?? "")] };
  }

  /** Return the visible portions of changed piles for one connected player. */
  getStateDelta(roomCode: string, playerId: string, changedPiles: string[], entry: HistoryEntry): StateDelta {
    const room = this.rooms.get(roomCode);
    if (!room?.state) throw new Error("Room or state not found");
    const piles: Record<string, string[]> = {};
    for (const pileKey of new Set(changedPiles)) {
      const baseName = pileKey.split(":")[0];
      const pileDef = room.state.G.pileDefs[baseName];
      const isOwnPrivatePile = pileKey === `${baseName}:${playerId}`;
      piles[pileKey] = pileDef?.area === "private" && !isOwnPrivatePile
        ? []
        : [...(room.state.G.piles[pileKey] ?? [])];
    }
    return { turn: room.state.ctx.turn, piles, entry };
  }

  /**
   * Get a sanitised state for a specific player.
   * Private piles that don't belong to the player are excluded.
   */
  getStateForPlayer(roomCode: string, playerId: string): { state: State; entries: HistoryEntry[] } {
    const room = this.rooms.get(roomCode);
    if (!room || !room.state) throw new Error("Room or state not found");

    // Deep clone to avoid leaking mutations
    const state: State = JSON.parse(JSON.stringify(room.state));
    const history = this.history.get(roomCode) ?? [];

    // Filter out other players' private piles
    for (const [pileKey, pileDef] of Object.entries(state.G.pileDefs)) {
      if (pileDef.area === "private") {
        // Remove private piles belonging to other players
        for (const key of Object.keys(state.G.piles)) {
          if (key.startsWith(`${pileKey}:`) && key !== `${pileKey}:${playerId}`) {
            // Replace with empty array instead of deleting to keep structure consistent
            state.G.piles[key] = [];
          }
        }
      }
    }

    return { state, entries: history };
  }

  /**
   * Get players in a room.
   */
  getPlayers(roomCode: string): Player[] | undefined {
    return this.rooms.get(roomCode)?.players;
  }

  /**
   * Get room info.
   */
  getRoom(roomCode: string): Room | undefined {
    return this.rooms.get(roomCode);
  }

  private generateUniqueCode(): string {
    let code: string;
    do {
      code = generateRoomCode();
    } while (this.rooms.has(code));
    return code;
  }
}

/** Generate an opaque, high-entropy token for one browser session. */
function createResumeToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Compare tokens without exposing partial-match timing information. */
function tokensMatch(expected: string, received: string): boolean {
  const expectedBuffer = Buffer.from(expected);
  const receivedBuffer = Buffer.from(received);
  return expectedBuffer.length === receivedBuffer.length && timingSafeEqual(expectedBuffer, receivedBuffer);
}

/** Resolve a client pile reference to its concrete room state key. */
function resolveRoomPileKey(G: State["G"], pileName: string, playerId: string): string {
  if (G.piles[pileName]) return pileName;
  return G.pileDefs[pileName]?.area === "private" ? `${pileName}:${playerId}` : pileName;
}
