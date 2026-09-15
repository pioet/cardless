import test from "node:test";
import assert from "node:assert/strict";
import { createInitialG } from "../src/state.ts";
import type { CardDef, PileDef, Player } from "../src/types.ts";

const players: Player[] = [{ id: "p1", name: "Alice" }];

test("initializes cards into the first compatible public pile by category", async () => {
  const cardDefs: Record<string, CardDef> = {
    Ember: { name: "Ember", category: "fire", count: 2 },
    Tide: { name: "Tide", category: "water" },
    Blank: { name: "Blank" },
  };
  const pileDefs: Record<string, PileDef> = {
    fireDeck: { name: "fireDeck", area: "public", orientation: "down", category: "fire" },
    waterDeck: { name: "waterDeck", area: "public", orientation: "down", category: "water" },
    generalDeck: { name: "generalDeck", area: "public", orientation: "down" },
    hand: { name: "hand", area: "private", orientation: "down", category: "fire" },
  };

  const G = await createInitialG(".", cardDefs, pileDefs, players);

  assert.deepEqual(G.piles.fireDeck, ["card-0", "card-1"]);
  assert.deepEqual(G.piles.waterDeck, ["card-2"]);
  assert.deepEqual(G.piles.generalDeck, ["card-3"]);
  assert.deepEqual(G.piles["hand:p1"], []);
  assert.equal(G.piles["rx:p1"], undefined);
  assert.equal(G.pileDefs.rx, undefined);
});

test("uses an uncategorized public pile as the first compatible target", async () => {
  const cardDefs: Record<string, CardDef> = {
    Ember: { name: "Ember", category: "fire" },
    Tide: { name: "Tide", category: "water" },
  };
  const pileDefs: Record<string, PileDef> = {
    generalDeck: { name: "generalDeck", area: "public", orientation: "down" },
    fireDeck: { name: "fireDeck", area: "public", orientation: "down", category: "fire" },
  };

  const G = await createInitialG(".", cardDefs, pileDefs, players);

  assert.deepEqual(G.piles.generalDeck, ["card-0", "card-1"]);
  assert.deepEqual(G.piles.fireDeck, []);
});

test("fails initialization when a card category has no compatible public pile", async () => {
  const cardDefs: Record<string, CardDef> = {
    Ember: { name: "Ember", category: "fire" },
  };
  const pileDefs: Record<string, PileDef> = {
    waterDeck: { name: "waterDeck", area: "public", orientation: "down", category: "water" },
    hand: { name: "hand", area: "private", orientation: "down", category: "fire" },
  };

  await assert.rejects(
    createInitialG(".", cardDefs, pileDefs, players),
    /No compatible public pile found for fire cards/,
  );
});
