/**
 * cardless WebSocket server.
 *
 * Serves the client SPA on HTTP and handles real-time game communication via WebSocket.
 *
 * Protocol:
 *   Client → Server: ClientMessage (JSON)
 *   Server → Client: ServerMessage (JSON)
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import type { ServerMessage } from "./types.ts";
import { loadGameLobbyMetadata } from "./loader.ts";
import { RoomManager } from "./room.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Map of WebSocket → player info (roomCode + playerId) */
interface ConnectionInfo {
  roomCode: string;
  playerId: string;
}

/** One game project served by a CardlessServer instance. */
export interface ServedGame {
  id: string;
  gameDir: string;
}

export class CardlessServer {
  private roomManager: RoomManager;
  private games: Map<string, ServedGame>;
  private locale?: string;
  private connections = new Map<WebSocket, ConnectionInfo>();
  /** Room code → set of connected websockets */
  private roomSockets = new Map<string, Set<WebSocket>>();

  constructor(games: ServedGame[] | string, locale?: string) {
    const servedGames = typeof games === "string" ? [{ id: "default", gameDir: games }] : games;
    if (servedGames.length === 0) throw new Error("At least one game project is required");
    this.games = new Map(servedGames.map((game) => [game.id, game]));
    this.locale = locale;
    this.roomManager = new RoomManager();
  }

  /**
   * Start the server on the given port.
   */
  async start(port: number): Promise<void> {
    const server = http.createServer((req, res) => {
      void this.handleHttp(req, res);
    });

    const wss = new WebSocketServer({ server });

    wss.on("connection", (ws) => {
      ws.on("message", (data) => {
        this.handleMessage(ws, data.toString());
      });

      ws.on("close", () => {
        this.handleDisconnect(ws);
      });

      ws.on("error", () => {
        this.handleDisconnect(ws);
      });
    });

    return new Promise<void>((resolve) => {
      server.listen(port, () => {
        resolve();
      });
    });
  }

  private async handleHttp(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

    if (url.pathname === "/config.json") {
      try {
        const games = await Promise.all([...this.games.values()].map(async (game) => {
          const metadata = await loadGameLobbyMetadata(game.gameDir, this.locale);
          return { id: game.id, name: metadata.name };
        }));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ games }));
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: message }));
      }
      return;
    }

    if (url.pathname.startsWith("/game-assets/")) {
      this.serveGameAsset(url, res);
      return;
    }

    let filePath = url.pathname;

    // Serve SPA for all routes (client-side routing)
    if (filePath === "/" || !filePath.includes(".")) {
      filePath = "/index.html";
    }

    // Try client files
    const clientDir = path.join(__dirname, "client");
    const fullPath = path.join(clientDir, filePath);

    try {
      const content = fs.readFileSync(fullPath);
      const ext = path.extname(fullPath);
      const mime: Record<string, string> = {
        ".html": "text/html",
        ".js": "application/javascript",
        ".css": "text/css",
        ".json": "application/json",
        ".png": "image/png",
        ".svg": "image/svg+xml",
        ".ico": "image/x-icon",
      };
      res.writeHead(200, { "Content-Type": mime[ext] ?? "application/octet-stream" });
      res.end(content);
    } catch {
      // File not found, serve index.html for SPA
      try {
        const index = fs.readFileSync(path.join(clientDir, "index.html"));
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(index);
      } catch {
        res.writeHead(404);
        res.end("Not found");
      }
    }
  }

  /**
   * Serve read-only assets from the game directory identified by the route.
   * Card face image paths in card.csv are resolved relative to that directory.
   */
  private serveGameAsset(url: URL, res: http.ServerResponse) {
    let gameId: string;
    let assetPath: string;
    try {
      const parts = url.pathname.slice("/game-assets/".length).split("/");
      gameId = decodeURIComponent(parts.shift() ?? "");
      assetPath = parts.map((part) => decodeURIComponent(part)).join("/");
    } catch {
      res.writeHead(400);
      res.end("Bad request");
      return;
    }

    const game = this.games.get(gameId);
    if (!game || !assetPath) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const fullPath = path.resolve(game.gameDir, assetPath);
    const gameRoot = path.resolve(game.gameDir);

    if (fullPath !== gameRoot && !fullPath.startsWith(`${gameRoot}${path.sep}`)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    try {
      const stat = fs.statSync(fullPath);
      if (!stat.isFile()) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      const content = fs.readFileSync(fullPath);
      res.writeHead(200, {
        "Content-Type": this.getMimeType(fullPath),
        "Cache-Control": "public, max-age=3600",
      });
      res.end(content);
    } catch {
      res.writeHead(404);
      res.end("Not found");
    }
  }

  private getMimeType(filePath: string): string {
    const mime: Record<string, string> = {
      ".avif": "image/avif",
      ".gif": "image/gif",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".png": "image/png",
      ".svg": "image/svg+xml",
      ".webp": "image/webp",
    };
    return mime[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
  }

  private async handleMessage(ws: WebSocket, raw: string) {
    let msg: { type: string; [key: string]: unknown };
    try {
      msg = JSON.parse(raw);
    } catch {
      this.send(ws, { type: "error", message: "Invalid JSON" });
      return;
    }

    try {
      switch (msg.type) {
        case "create":
          await this.handleCreate(ws, msg.playerName as string, msg.gameId as string | undefined);
          break;
        case "join":
          await this.handleJoin(ws, msg.room as string, msg.playerName as string);
          break;
        case "resume":
          await this.handleResume(ws, msg.room as string, msg.playerId as string, msg.resumeToken as string);
          break;
        case "sync":
          await this.handleSync(ws);
          break;
        case "start":
          await this.handleStart(ws);
          break;
        case "move": {
          const action = msg.action as { from: string; to: string; cardIds: string[]; pickMethod?: "top" | "random" | "all" };
          await this.handleMove(ws, action);
          break;
        }
        case "shuffle":
          await this.handleShuffle(ws, msg.pile as string);
          break;
        case "sort":
          await this.handleSort(ws, msg.pile as string);
          break;
        default:
          this.send(ws, { type: "error", message: `Unknown message type: ${msg.type}` });
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.send(ws, { type: "error", message });
    }
  }

  private getRoomExtra(roomCode: string): { gameId: string; gameName: string; gameHelp: string; customActions: import("./types.ts").CustomActionDef[] } {
    const room = this.roomManager.getRoom(roomCode);
    return {
      gameId: room?.gameId ?? "",
      gameName: room?.config.name ?? "",
      gameHelp: room?.config.help ?? "",
      customActions: room?.config.customActions ?? [],
    };
  }

  private async handleCreate(ws: WebSocket, playerName: string, requestedGameId?: string) {
    const gameId = requestedGameId || (this.games.size === 1 ? this.games.keys().next().value : undefined);
    const game = gameId ? this.games.get(gameId) : undefined;
    if (!game) throw new Error("Please choose a game before creating a room");
    const result = await this.roomManager.createRoom(game.gameDir, game.id, playerName, this.locale);
    this.bindConnection(ws, { roomCode: result.room, playerId: result.playerId });

    const extra = this.getRoomExtra(result.room);
    this.send(ws, {
      type: "room_created",
      room: result.room,
      playerId: result.playerId,
      resumeToken: result.resumeToken,
      gameId: extra.gameId,
      gameName: extra.gameName,
      gameHelp: extra.gameHelp,
      customActions: extra.customActions,
    });

    // Broadcast players (just the creator)
    const players = this.roomManager.getPlayers(result.room);
    if (players) {
      this.broadcast(result.room, {
        type: "players_updated",
        players,
      });
    }
  }

  private async handleJoin(ws: WebSocket, roomCode: string, playerName: string) {
    const result = this.roomManager.joinRoom(roomCode.toUpperCase(), playerName);
    this.bindConnection(ws, { roomCode: result.room, playerId: result.playerId });

    // Send room_joined to the joining player
    const extra = this.getRoomExtra(result.room);
    this.send(ws, {
      type: "room_joined",
      room: result.room,
      playerId: result.playerId,
      resumeToken: result.resumeToken,
      gameId: extra.gameId,
      players: result.players,
      gameName: extra.gameName,
      gameHelp: extra.gameHelp,
      customActions: extra.customActions,
    });

    // Broadcast players_updated to all players in the room
    this.broadcast(result.room, {
      type: "players_updated",
      players: result.players,
    });
  }

  /** Restore an existing player without creating a new room membership. */
  private async handleResume(ws: WebSocket, roomCode: string, playerId: string, resumeToken: string) {
    const normalizedRoomCode = roomCode.toUpperCase();
    const room = this.roomManager.resumeRoom(normalizedRoomCode, playerId, resumeToken);
    this.bindConnection(ws, { roomCode: normalizedRoomCode, playerId });
    const extra = this.getRoomExtra(normalizedRoomCode);

    if (!room.state) {
      this.send(ws, {
        type: "room_resumed",
        room: normalizedRoomCode,
        playerId,
        gameId: extra.gameId,
        players: room.players,
        gameName: extra.gameName,
        gameHelp: extra.gameHelp,
        customActions: extra.customActions,
      });
      return;
    }

    const playerView = this.roomManager.getStateForPlayer(normalizedRoomCode, playerId);
    this.send(ws, {
      type: "game_resumed",
      state: playerView.state,
      playerId,
      gameId: extra.gameId,
      players: room.players,
      entries: playerView.entries,
      gameName: extra.gameName,
      gameHelp: extra.gameHelp,
      customActions: extra.customActions,
    });
  }

  private async handleStart(ws: WebSocket) {
    const cinfo = this.connections.get(ws);
    if (!cinfo) {
      this.send(ws, { type: "error", message: "Not connected to a room" });
      return;
    }

    const state = await this.roomManager.startGame(cinfo.roomCode, cinfo.playerId);
    const extra = this.getRoomExtra(cinfo.roomCode);

    // Send game_started to each player with their personalised view
    for (const [sock, info] of this.connections) {
      if (info.roomCode === cinfo.roomCode) {
        const playerView = this.roomManager.getStateForPlayer(cinfo.roomCode, info.playerId);
        this.send(sock, {
          type: "game_started",
          state: playerView.state,
          playerId: info.playerId,
          gameId: extra.gameId,
          entries: playerView.entries,
          gameName: extra.gameName,
          gameHelp: extra.gameHelp,
          customActions: extra.customActions,
        });
      }
    }
  }

  private async handleMove(ws: WebSocket, action: { from: string; to: string; cardIds: string[]; pickMethod?: "top" | "random" | "all" }) {
    const cinfo = this.connections.get(ws);
    if (!cinfo) {
      this.send(ws, { type: "error", message: "Not connected to a room" });
      return;
    }

    const result = this.roomManager.processMove(cinfo.roomCode, cinfo.playerId, action.from, action.to, action.cardIds, action.pickMethod);
    this.broadcastDelta(cinfo.roomCode, result.changedPiles, result.entry);
  }

  private async handleShuffle(ws: WebSocket, pileName: string) {
    const cinfo = this.connections.get(ws);
    if (!cinfo) {
      this.send(ws, { type: "error", message: "Not connected to a room" });
      return;
    }

    const result = this.roomManager.processShuffle(cinfo.roomCode, pileName, cinfo.playerId);
    this.broadcastDelta(cinfo.roomCode, result.changedPiles, result.entry);
  }

  private async handleSort(ws: WebSocket, pileName: string) {
    const cinfo = this.connections.get(ws);
    if (!cinfo) {
      this.send(ws, { type: "error", message: "Not connected to a room" });
      return;
    }

    const result = this.roomManager.processSort(cinfo.roomCode, pileName, cinfo.playerId);
    this.broadcastDelta(cinfo.roomCode, result.changedPiles, result.entry);
  }

  /** Send a complete player-specific snapshot after a client detects a missed update. */
  private async handleSync(ws: WebSocket) {
    const connection = this.connections.get(ws);
    if (!connection) throw new Error("Not connected to a room");
    const room = this.roomManager.getRoom(connection.roomCode);
    if (!room?.state) throw new Error("Game not started");
    const extra = this.getRoomExtra(connection.roomCode);
    const view = this.roomManager.getStateForPlayer(connection.roomCode, connection.playerId);
    this.send(ws, {
      type: "game_resumed", state: view.state, playerId: connection.playerId,
      gameId: extra.gameId, players: room.players, entries: view.entries,
      gameName: extra.gameName, gameHelp: extra.gameHelp, customActions: extra.customActions,
    });
  }

  private handleDisconnect(ws: WebSocket) {
    const cinfo = this.connections.get(ws);
    if (cinfo) {
      const sockets = this.roomSockets.get(cinfo.roomCode);
      if (sockets) {
        sockets.delete(ws);
        if (sockets.size === 0) {
          this.roomSockets.delete(cinfo.roomCode);
          this.roomManager.deleteRoom(cinfo.roomCode);
        }
      }

    }
    this.connections.delete(ws);
  }

  /** Bind a socket to a player, replacing any older connection for that player. */
  private bindConnection(ws: WebSocket, connection: ConnectionInfo): void {
    for (const [existingSocket, existingConnection] of this.connections) {
      if (
        existingSocket !== ws
        && existingConnection.roomCode === connection.roomCode
        && existingConnection.playerId === connection.playerId
      ) {
        this.removeConnection(existingSocket);
        existingSocket.close(4000, "Replaced by a newer connection");
      }
    }

    this.connections.set(ws, connection);
    if (!this.roomSockets.has(connection.roomCode)) {
      this.roomSockets.set(connection.roomCode, new Set());
    }
    this.roomSockets.get(connection.roomCode)!.add(ws);
  }

  /** Remove a socket from server connection indexes without changing membership. */
  private removeConnection(ws: WebSocket): void {
    const connection = this.connections.get(ws);
    if (!connection) return;
    this.connections.delete(ws);
    const sockets = this.roomSockets.get(connection.roomCode);
    if (!sockets) return;
    sockets.delete(ws);
    if (sockets.size === 0) {
      this.roomSockets.delete(connection.roomCode);
    }
  }

  private broadcastState(roomCode: string) {
    const sockets = this.roomSockets.get(roomCode);
    if (!sockets) return;

    const extra = this.getRoomExtra(roomCode);

    for (const sock of sockets) {
      const cinfo = this.connections.get(sock);
      if (!cinfo) continue;

      const playerView = this.roomManager.getStateForPlayer(roomCode, cinfo.playerId);
      this.send(sock, {
        type: "state_updated",
        state: playerView.state,
        playerId: cinfo.playerId,
        gameId: extra.gameId,
        entries: playerView.entries,
        gameName: extra.gameName,
        gameHelp: extra.gameHelp,
        customActions: extra.customActions,
      });
    }
  }

  /** Broadcast only the piles changed by one operation to each player's view. */
  private broadcastDelta(roomCode: string, changedPiles: string[], entry: import("./types.ts").HistoryEntry) {
    const sockets = this.roomSockets.get(roomCode);
    if (!sockets) return;
    const extra = this.getRoomExtra(roomCode);
    for (const socket of sockets) {
      const connection = this.connections.get(socket);
      if (!connection) continue;
      this.send(socket, {
        type: "state_delta",
        delta: this.roomManager.getStateDelta(roomCode, connection.playerId, changedPiles, entry),
        playerId: connection.playerId,
        gameId: extra.gameId,
        gameName: extra.gameName,
        gameHelp: extra.gameHelp,
        customActions: extra.customActions,
      });
    }
  }

  private send(ws: WebSocket, msg: ServerMessage) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  private broadcast(roomCode: string, msg: ServerMessage) {
    const sockets = this.roomSockets.get(roomCode);
    if (!sockets) return;
    for (const sock of sockets) {
      this.send(sock, msg);
    }
  }
}
