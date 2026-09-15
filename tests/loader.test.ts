import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { discoverGameProjects, loadGameConfig } from "../src/loader.ts";

const coupGameDir = path.resolve("games/coup-zh");

test("loads the configured default language pack", async () => {
  const config = await loadGameConfig(coupGameDir);

  assert.equal(config.locale, "zh-CN");
  assert.equal(config.name, "政变");
  assert.equal(config.card, "locales/zh-CN/card.csv");
  assert.equal(config.version, "1.0.0");
});

test("loads an explicitly selected language pack", async () => {
  const config = await loadGameConfig(coupGameDir, "en");

  assert.equal(config.locale, "en");
  assert.equal(config.name, "Coup");
  assert.equal(config.card, "locales/en/card.csv");
  assert.match(config.help ?? "", /Each player starts/);
});

test("rejects unsafe language pack identifiers", async () => {
  await assert.rejects(
    loadGameConfig(coupGameDir, "../en"),
    /Invalid locale/,
  );
});

test("loads a single-language game from its default language pack", async () => {
  const config = await loadGameConfig(path.resolve("games/poker"));

  assert.equal(config.locale, "en");
  assert.equal(config.name, "Poker");
  assert.equal(config.card, "locales/en/card.csv");
});

test("discovers immediate game projects for multi-game mode", async () => {
  const games = await discoverGameProjects("games", process.cwd());

  const ids = games.map((game) => game.id);
  assert.ok(ids.includes("coup-zh"));
  assert.ok(ids.includes("poker"));
});
