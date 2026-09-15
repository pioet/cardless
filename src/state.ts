/**
 * Game state factory — initializes G and Ctx from loaded definitions.
 *
 * On game start, cards are placed into compatible public piles by category,
 * and per-player private piles are created for each player.
 */

import type { Card, CardDef, G, Ctx, PileDef, State, Player } from "./types.ts";
import { loadCardDefs, loadPileDefs } from "./loader.ts";

/**
 * Create the initial game state G from loaded definitions and players.
 *
 * Process:
 * 1. Create card instances from the card definitions.
 *    Each card def can specify a `count` (default: 1) for multiple copies.
 * 2. Group card instances by category in card definition order.
 * 3. Place each group into the first compatible public pile in pile definition order.
 * 4. For each private pile, create a per-player instance (e.g. "hand:player1").
 * 5. Public piles are shared.
 */
export async function createInitialG(
  gameDir: string,
  cardDefs: Record<string, CardDef>,
  pileDefs: Record<string, PileDef>,
  players: Player[],
): Promise<G> {
  const cards: Record<string, Card> = {};
  const piles: Record<string, string[]> = {};
  let cardIndex = 0;

  // 1. Create card instances — support multiple copies via `count` field
  for (const [defId, def] of Object.entries(cardDefs)) {
    const copies = def.count ?? 1;
    for (let i = 0; i < copies; i++) {
      const cardId = `card-${cardIndex}`;
      cards[cardId] = { id: cardId, defId: def.name };
      cardIndex++;
    }
  }

  // 2. Create piles
  for (const [pileName, pileDef] of Object.entries(pileDefs)) {
    if (pileDef.area === "private") {
      // Per-player private piles
      for (const player of players) {
        const key = `${pileName}:${player.id}`;
        piles[key] = [];
      }
    } else {
      // Public pile — first one gets all cards (the "deck")
      piles[pileName] = [];
    }
  }

  // Build cardDefs map keyed by def name
  const defsMap: Record<string, CardDef> = {};
  for (const [, def] of Object.entries(cardDefs)) {
    defsMap[def.name] = def;
  }

  placeCardsInCompatiblePublicPiles(cards, defsMap, pileDefs, piles);

  return {
    cardDefs: defsMap,
    cards,
    piles,
    pileDefs,
  };
}

/**
 * Place cards by category while preserving CSV-driven definition order.
 *
 * Empty pile categories accept any card category. Non-empty pile categories
 * accept only cards with the exact same category.
 */
function placeCardsInCompatiblePublicPiles(
  cards: Record<string, Card>,
  cardDefs: Record<string, CardDef>,
  pileDefs: Record<string, PileDef>,
  piles: Record<string, string[]>,
): void {
  const cardsByCategory = groupCardsByCategory(cards, cardDefs);

  for (const [category, cardIds] of cardsByCategory) {
    const targetPile = findFirstCompatiblePublicPile(category, pileDefs);
    if (!targetPile) {
      const label = category || "uncategorized";
      throw new Error(`No compatible public pile found for ${label} cards`);
    }
    piles[targetPile].push(...cardIds);
  }
}

function groupCardsByCategory(
  cards: Record<string, Card>,
  cardDefs: Record<string, CardDef>,
): Map<string, string[]> {
  const grouped = new Map<string, string[]>();

  for (const [cardId, card] of Object.entries(cards)) {
    const category = cardDefs[card.defId]?.category ?? "";
    const existing = grouped.get(category);
    if (existing) {
      existing.push(cardId);
    } else {
      grouped.set(category, [cardId]);
    }
  }

  return grouped;
}

function findFirstCompatiblePublicPile(
  cardCategory: string,
  pileDefs: Record<string, PileDef>,
): string | null {
  for (const [pileName, pileDef] of Object.entries(pileDefs)) {
    if (pileDef.area !== "public") continue;
    if (!pileDef.category || pileDef.category === cardCategory) {
      return pileName;
    }
  }

  return null;
}

/**
 * Create the initial Ctx for a new game session.
 */
export function createInitialCtx(players: Player[]): Ctx {
  const playerIds = players.map((p) => p.id);
  return {
    numPlayers: players.length,
    playOrder: playerIds,
    playOrderPos: 0,
    activePlayers: null, // all players can act
    currentPlayer: playerIds[0] ?? "",
    turn: 1,
    phase: "play",
  };
}

/**
 * Create the initial State for a new game.
 */
export async function createInitialState(
  gameDir: string,
  config: { card: string; pile: string },
  players: Player[],
): Promise<State> {
  const cardDefs = await loadCardDefs(gameDir, config.card);
  const pileDefs = await loadPileDefs(gameDir, config.pile);
  const G = await createInitialG(gameDir, cardDefs, pileDefs, players);
  const ctx = createInitialCtx(players);
  return { G, ctx };
}
