/**
 * Game actions — mutable operations on G.
 *
 * These are the only functions that mutate the game state.
 * They are called by the server when processing client moves.
 *
 * Note: cardless does NOT implement game-logic validation.
 * Any player can move any cards between any piles at any time.
 */

import type { G, MoveAction, HistoryEntry, Player } from "./types.ts";

/**
 * Strip the ":playerId" suffix from a pile key to get its base name.
 */
function stripPlayerSuffix(pileKey: string): string {
  const idx = pileKey.indexOf(":");
  return idx >= 0 ? pileKey.slice(0, idx) : pileKey;
}

/**
 * Format pile names for player-facing history.
 * Private piles are shown as self:<pile> to avoid leaking player-specific IDs.
 */
function formatPileForHistory(G: G, pileKey: string): string {
  const baseName = stripPlayerSuffix(pileKey);
  const def = G.pileDefs[baseName];
  return def?.area === "private" ? `self:${baseName}` : baseName;
}

function isPublicPile(G: G, pileKey: string): boolean {
  const baseName = stripPlayerSuffix(pileKey);
  return G.pileDefs[baseName]?.area === "public";
}

/**
 * Get the names of the moved cards for display.
 */
function getMovedCardNames(G: G, cardIds: string[]): string[] {
  return cardIds.map((id) => {
    const card = G.cards[id];
    if (!card) return id;
    const def = G.cardDefs[card.defId];
    return def?.name || def?.center || card.defId || id;
  });
}

/**
 * Move card instances from one pile to another.
 * Returns a history entry describing what happened.
 */
export function moveCards(G: G, action: MoveAction, players: Player[]): HistoryEntry {
  const { from, to, cardIds, playerId, pickMethod } = action;

  // Resolve private pile keys for the acting player
  const fromPile = resolvePileKey(G, from, playerId);
  const toPile = resolvePileKey(G, to, playerId);

  // Validate source pile exists
  if (!G.piles[fromPile]) {
    throw new Error(`Source pile "${fromPile}" does not exist`);
  }
  if (!G.piles[toPile]) {
    throw new Error(`Target pile "${toPile}" does not exist`);
  }

  // Enforce optional pile category constraints on the server.
  const toBaseForValidation = stripPlayerSuffix(to);
  const targetCategory = G.pileDefs[toBaseForValidation]?.category;
  if (targetCategory) {
    for (const cardId of cardIds) {
      const card = G.cards[cardId];
      const cardCategory = card ? G.cardDefs[card.defId]?.category : undefined;
      if (cardCategory !== targetCategory) {
        throw new Error(
          `Pile "${toBaseForValidation}" only accepts "${targetCategory}" cards`,
        );
      }
    }
  }

  // Remove card IDs from source pile in order
  const sourcePile = G.piles[fromPile];
  const remaining: string[] = [];
  const moved: string[] = [];

  for (const cid of sourcePile) {
    if (cardIds.includes(cid)) {
      moved.push(cid);
    } else {
      remaining.push(cid);
    }
  }

  // Check all requested cards were found
  if (moved.length !== cardIds.length) {
    const missing = cardIds.filter((id) => !moved.includes(id));
    throw new Error(
      `Cards not found in "${fromPile}": ${missing.join(", ")}`,
    );
  }

  G.piles[fromPile] = remaining;

  // Append to target pile (at the bottom / end)
  G.piles[toPile] = [...G.piles[toPile], ...moved];

  // Derive player name
  const player = players.find((p) => p.id === playerId);
  const playerName = player?.name ?? playerId;

  // Build detail: only public face-up destinations reveal moved card names.
  // Private destinations stay hidden in shared history even when their pile
  // orientation is configured as face-up for the owning player.
  const fromBase = stripPlayerSuffix(from);
  const toBase = stripPlayerSuffix(to);
  const fromLabel = formatPileForHistory(G, from);
  const toLabel = formatPileForHistory(G, to);
  const toDef = G.pileDefs[toBase];
  const showCardNames = toDef && toDef.area === "public" && toDef.orientation === "up";
  const pickText = pickMethod === "top" || pickMethod === "random" ? ` (${pickMethod})` : "";
  let detail = `Moved ${moved.length} card(s)${pickText} from ${fromLabel} to ${toLabel}`;
  if (showCardNames) {
    const names = getMovedCardNames(G, moved);
    detail += `: ${names.join(", ")}`;
  }

  return {
    timestamp: Date.now(),
    playerId,
    playerName,
    action: "move",
    detail,
    isPublicAction: isPublicPile(G, from) || isPublicPile(G, to),
  };
}

/**
 * Shuffle a pile (Fisher-Yates).
 * Only public piles can be shuffled (private piles belong to a single player).
 */
export function shufflePile(G: G, pileName: string, playerName?: string, playerId?: string): HistoryEntry {
  const pileKey = pileName; // shuffling is always on the base pile name

  if (!G.piles[pileKey]) {
    throw new Error(`Pile "${pileKey}" does not exist`);
  }

  const pile = G.piles[pileKey];
  // Fisher-Yates shuffle
  for (let i = pile.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pile[i], pile[j]] = [pile[j], pile[i]];
  }
  G.piles[pileKey] = pile;

  return {
    timestamp: Date.now(),
    playerId,
    playerName: playerName ?? "System",
    action: "shuffle",
    detail: `Shuffled ${formatPileForHistory(G, pileName)} (${pile.length} cards)`,
    isPublicAction: isPublicPile(G, pileName),
  };
}

/**
 * Sort a pile's cards by their numeric card ID (ascending).
 * This provides a deterministic visual ordering matching the CSV definition order.
 */
export function sortPile(G: G, pileName: string, playerName?: string, playerId?: string): HistoryEntry {
  const pileKey = pileName;

  if (!G.piles[pileKey]) {
    throw new Error(`Pile "${pileKey}" does not exist`);
  }

  const pile = G.piles[pileKey];
  // Numeric sort by card ID index so that card-0, card-1, ..., card-10, card-11 are in order
  pile.sort((a, b) => {
    const numA = parseInt(a.replace(/^card-/, ""), 10);
    const numB = parseInt(b.replace(/^card-/, ""), 10);
    return numA - numB;
  });
  G.piles[pileKey] = pile;

  return {
    timestamp: Date.now(),
    playerId,
    playerName: playerName ?? "System",
    action: "sort",
    detail: `Sorted ${formatPileForHistory(G, pileName)} (${pile.length} cards)`,
    isPublicAction: isPublicPile(G, pileName),
  };
}

/**
 * Resolve a pile key to its actual key in G.piles.
 * For private piles, appends ":playerId".
 * For public piles, returns the base name.
 */
function resolvePileKey(G: G, pileName: string, playerId: string): string {
  const def = G.pileDefs[pileName];
  if (!def) {
    // Try the raw key
    if (G.piles[pileName]) return pileName;
    throw new Error(`Unknown pile: "${pileName}"`);
  }
  if (def.area === "private") {
    return `${pileName}:${playerId}`;
  }
  return pileName;
}

/**
 * Pick a number of cards from a pile (top or random).
 * Returns the card IDs picked but does NOT remove them.
 * Used for client-side selection UX — actual removal happens via moveCards.
 */
export function pickCards(G: G, pileName: string, playerId: string, count: number, from: "top" | "random"): string[] {
  const pileKey = resolvePileKey(G, pileName, playerId);
  const pile = G.piles[pileKey];
  if (!pile || pile.length === 0) return [];
  const n = Math.min(count, pile.length);

  if (from === "top") {
    return pile.slice(pile.length - n);
  } else {
    // Random pick without replacement
    const indices = new Set<number>();
    while (indices.size < n) {
      indices.add(Math.floor(Math.random() * pile.length));
    }
    return [...indices].sort((a, b) => a - b).map((i) => pile[i]);
  }
}
