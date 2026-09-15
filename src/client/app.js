/**
 * cardless client-side application.
 *
 * Manages the SPA lifecycle — lobby → room → game.
 * Communicates with the server via WebSocket.
 */

// ── State ──────────────────────────────────────────────────────────────────
let ws = null;
let myPlayerId = null;
let myPlayerName = "";
let currentRoom = "";
let gameState = null;
let players = [];
let historyEntries = [];
let currentPile = null;
let selectedCards = [];
let faceUpPileViewMode = "normal";
let customPickButtons = [];
/** Predefined custom actions from game.toml (synced on each server message) */
let predefinedActions = [];
let isOwner = false;
let toastTimeout = null;
let knownHistoryLength = 0; // track how many history entries we've already seen
let lobbyMode = "create";
let lastPickMethod = null;
let actionEffectTimeout = null;
let customPickDraftMethod = "top";
let customPickDraftCount = 2;
let pendingConfirmAction = null;
let restoringSession = false;
let availableGames = [];
let selectedGameId = "";
let activeGameId = "";
window._gameName = "";
window._gameHelp = "";

const SESSION_STORAGE_KEY = "cardless.room-session";

// ── DOM References ─────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

const screens = {
  lobby: $("screen-lobby"),
  room: $("screen-room"),
  game: $("screen-game"),
};

syncViewportHeight();
window.addEventListener("resize", syncViewportHeight);
window.visualViewport?.addEventListener("resize", syncViewportHeight);

/**
 * Keep a pixel fallback for browsers that do not support dynamic viewport
 * units. Modern browsers use 100dvh from CSS so the screen fills completely.
 */
function syncViewportHeight() {
  const height = window.innerHeight;
  document.documentElement.style.setProperty("--app-height", `${height}px`);
}

// ── WebSocket Connection ───────────────────────────────────────────────────
function connect() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${protocol}//${location.host}`;
  ws = new WebSocket(url);

  ws.onopen = () => {
    console.log("Connected to cardless server");
    updateResumeButton();
  };

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    handleMessage(msg);
  };

  ws.onclose = (event) => {
    if (event.code === 4000) {
      showToast("This session was opened in another tab");
      return;
    }
    showLobbyForRecovery();
    console.log("Disconnected. Reconnecting in 2s...");
    setTimeout(connect, 2000);
  };

  ws.onerror = () => {
    ws.close();
  };
}

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

/** Return the most recently saved player session for this server origin. */
function loadStoredSession() {
  try {
    const stored = JSON.parse(localStorage.getItem(SESSION_STORAGE_KEY) || "null");
    if (
      stored
      && typeof stored.room === "string"
      && typeof stored.playerId === "string"
      && typeof stored.resumeToken === "string"
    ) {
      return stored;
    }
  } catch {
    // Invalid local data is treated as an expired session.
  }
  clearStoredSession();
  return null;
}

/** Persist a server-issued recovery token after creating or joining a room. */
function saveSession(message) {
  if (!message.resumeToken) return;
  try {
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({
      room: message.room,
      playerId: message.playerId,
      resumeToken: message.resumeToken,
    }));
  } catch {
    // The game remains playable when browser storage is unavailable.
  }
}

/** Forget an unrecoverable session so the normal lobby flow can continue. */
function clearStoredSession() {
  try {
    localStorage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    // Storage may be disabled by the browser's privacy settings.
  }
}

// ── Message Handler ────────────────────────────────────────────────────────
function handleMessage(msg) {
  if (msg.gameId) activeGameId = msg.gameId;
  // Capture customActions from any server message that carries them
  if (msg.customActions && Array.isArray(msg.customActions)) {
    predefinedActions = msg.customActions;
  }

  switch (msg.type) {
    case "room_created":
      myPlayerId = msg.playerId;
      currentRoom = msg.room;
      saveSession(msg);
      updateGameName(msg.gameName);
      updateGameHelp(msg.gameHelp);
      showRoom();
      break;

    case "room_joined":
      myPlayerId = msg.playerId;
      currentRoom = msg.room;
      saveSession(msg);
      players = msg.players;
      updateGameName(msg.gameName);
      updateGameHelp(msg.gameHelp);
      showRoom();
      break;

    case "room_resumed":
      restoringSession = false;
      myPlayerId = msg.playerId;
      currentRoom = msg.room;
      players = msg.players;
      isOwner = msg.playerId === msg.players[0]?.id;
      updateGameName(msg.gameName);
      updateGameHelp(msg.gameHelp);
      showRoom();
      break;

    case "players_updated":
      players = msg.players;
      if (!screens.room.classList.contains("hidden")) {
        renderRoom();
      }
      break;

    case "game_started":
      myPlayerId = msg.playerId;
      gameState = msg.state;
      historyEntries = msg.entries || [];
      knownHistoryLength = historyEntries.length;
      updateGameName(msg.gameName);
      updateGameHelp(msg.gameHelp);
      initGame();
      break;

    case "game_resumed":
      restoringSession = false;
      myPlayerId = msg.playerId;
      players = msg.players;
      gameState = msg.state;
      historyEntries = msg.entries || [];
      knownHistoryLength = historyEntries.length;
      updateGameName(msg.gameName);
      updateGameHelp(msg.gameHelp);
      initGame();
      break;

    case "state_delta":
      applyStateDelta(msg.delta);
      break;

    case "state_updated":
      const previousHistoryLength = historyEntries.length;
      myPlayerId = msg.playerId;
      gameState = msg.state;
      historyEntries = msg.entries || [];
      const newEntries = historyEntries.slice(previousHistoryLength);
      knownHistoryLength = previousHistoryLength;
      updateGameName(msg.gameName || window._gameName);
      updateGameHelp(msg.gameHelp);
      renderGame();
      playActionEffect(newEntries[newEntries.length - 1]);
      knownHistoryLength = historyEntries.length;
      break;

    case "error":
      if (restoringSession) {
        restoringSession = false;
        clearStoredSession();
      }
      showToast(msg.message);
      break;
  }
}

/** Apply an ordered server delta, or request a snapshot when an update was missed. */
function applyStateDelta(delta) {
  if (!gameState || delta.turn !== gameState.ctx.turn + 1) {
    send({ type: "sync" });
    return;
  }
  Object.assign(gameState.G.piles, delta.piles);
  gameState.ctx.turn = delta.turn;
  historyEntries = [...historyEntries, delta.entry].slice(-20);
  knownHistoryLength = Math.max(0, historyEntries.length - 1);
  renderGame();
  playActionEffect(delta.entry);
  knownHistoryLength = historyEntries.length;
}

// ── Screen Management ──────────────────────────────────────────────────────
function showScreen(name) {
  Object.keys(screens).forEach((k) => {
    const isActive = k === name;
    screens[k].classList.toggle("hidden", !isActive);
    if (isActive) {
      restartAnimation(screens[k], "screen-enter");
    }
  });
}

// ── Lobby ──────────────────────────────────────────────────────────────────
$("btn-lobby-create-mode").addEventListener("click", () => {
  setLobbyMode("create");
});

$("btn-lobby-join-mode").addEventListener("click", () => {
  setLobbyMode("join");
});

$("btn-create").addEventListener("click", () => {
  const name = $("lobby-name").value.trim();
  if (!name) { showToast("Please enter your name"); return; }
  myPlayerName = name;
  isOwner = true;
  if (!selectedGameId) { showToast("Please choose a game"); return; }
  send({ type: "create", playerName: name, gameId: selectedGameId });
});

$("btn-join").addEventListener("click", () => {
  const name = $("lobby-name").value.trim();
  const code = $("lobby-room-code").value.trim().toUpperCase();
  if (!name) { showToast("Please enter your name"); return; }
  if (!code) { showToast("Please enter a room code"); return; }
  myPlayerName = name;
  isOwner = false;
  send({ type: "join", room: code, playerName: name });
});

$("btn-resume").addEventListener("click", () => {
  const session = loadStoredSession();
  if (!session) return;
  restoringSession = true;
  send({ type: "resume", ...session });
});

$("btn-copy-invite").addEventListener("click", copyInviteLink);
$("btn-home").addEventListener("click", returnToLobby);
$("btn-room-home").addEventListener("click", returnToLobby);

// Enter key shortcuts
$("lobby-name").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    if (lobbyMode === "join") $("btn-join").click();
    else $("btn-create").click();
  }
});
$("lobby-room-code").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("btn-join").click();
});

$("lobby-game").addEventListener("click", openGamePicker);
$("lobby-game").addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    openGamePicker();
  }
});
$("btn-game-picker-close").addEventListener("click", closeGamePicker);
$("game-picker-modal").addEventListener("click", (e) => {
  if (e.target.id === "game-picker-modal") closeGamePicker();
});

$("btn-custom-save").addEventListener("click", saveCustomPickButton);
$("btn-custom-cancel").addEventListener("click", closeCustomPickModal);
$("btn-delete-custom-confirm").addEventListener("click", deleteSelectedCustomPickButtons);
$("btn-delete-custom-cancel").addEventListener("click", closeDeleteCustomPickModal);
$("btn-confirm-ok").addEventListener("click", runPendingConfirmAction);
$("btn-confirm-cancel").addEventListener("click", closeConfirmModal);
$("btn-help").addEventListener("click", openHelpModal);
$("btn-help-close").addEventListener("click", closeHelpModal);
$("btn-card-info-close").addEventListener("click", closeCardInfoModal);
$("card-info-modal").addEventListener("click", (e) => {
  if (e.target.id === "card-info-modal") {
    closeCardInfoModal();
  }
});
$("custom-pick-modal").addEventListener("click", (e) => {
  if (e.target.id === "custom-pick-modal") {
    closeCustomPickModal();
  }
});
$("delete-custom-pick-modal").addEventListener("click", (e) => {
  if (e.target.id === "delete-custom-pick-modal") {
    closeDeleteCustomPickModal();
  }
});
$("confirm-modal").addEventListener("click", (e) => {
  if (e.target.id === "confirm-modal") {
    closeConfirmModal();
  }
});
$("help-modal").addEventListener("click", (e) => {
  if (e.target.id === "help-modal") {
    closeHelpModal();
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeCustomPickModal();
    closeDeleteCustomPickModal();
    closeConfirmModal();
    closeHelpModal();
    closeCardInfoModal();
    closeGamePicker();
  }
});
document.addEventListener("click", (e) => {
  const button = e.target.closest("button");
  if (button) {
    registerTapFeedback(button);
  }
}, true);

/**
 * Reveal the lobby fields that are relevant to the selected room flow.
 */
function setLobbyMode(mode) {
  lobbyMode = mode;
  $("lobby-room-code").classList.toggle("hidden", mode !== "join");
  $("lobby-game").classList.toggle("hidden", mode !== "create");
  $("btn-create").classList.toggle("hidden", mode !== "create");
  $("btn-join").classList.toggle("hidden", mode !== "join");
  $("btn-lobby-create-mode").classList.toggle("active", mode === "create");
  $("btn-lobby-join-mode").classList.toggle("active", mode === "join");
  $("btn-lobby-create-mode").setAttribute("aria-pressed", String(mode === "create"));
  $("btn-lobby-join-mode").setAttribute("aria-pressed", String(mode === "join"));
}

/** Show the lobby without discarding a recoverable room session. */
function showLobbyForRecovery() {
  gameState = null;
  selectedCards = [];
  showScreen("lobby");
  updateResumeButton();
}

/** Display the recovery control only while a saved session is available. */
function updateResumeButton() {
  $("btn-resume").classList.toggle("hidden", !loadStoredSession());
}

/** Leave the current connection while retaining the server-side player state. */
function returnToLobby() {
  if (ws && ws.readyState === WebSocket.OPEN) ws.close(1000, "Returned to lobby");
  showLobbyForRecovery();
}

/** Copy a direct invitation URL that pre-fills the room code for recipients. */
async function copyInviteLink() {
  const url = new URL(window.location.href);
  url.hash = "";
  url.search = "";
  url.searchParams.set("room", currentRoom);
  const inviteLink = url.toString();
  try {
    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(inviteLink);
        showToast("Invitation link copied");
        return;
      } catch {
        // Fall through for browsers that expose, but deny, Clipboard API access.
      }
    }
    const input = $("invite-link");
    input.focus();
    input.select();
    if (!document.execCommand("copy")) throw new Error("Copy command failed");
    showToast("Invitation link copied");
  } catch {
    showToast("Unable to copy invitation link");
  }
}

/** Read an invitation link once and prepare the join form without joining yet. */
function applyInviteLink() {
  const room = new URLSearchParams(location.search).get("room")?.trim().toUpperCase();
  if (!room) return;
  setLobbyMode("join");
  $("lobby-room-code").value = room;
}

// ── Room (Waiting) ─────────────────────────────────────────────────────────
function showRoom() {
  showScreen("room");
  renderRoom();
}

function renderRoom() {
  $("room-code-display").textContent = currentRoom;
  const inviteUrl = new URL(window.location.href);
  inviteUrl.hash = "";
  inviteUrl.search = "";
  inviteUrl.searchParams.set("room", currentRoom);
  $("invite-link").value = inviteUrl.toString();

  const list = $("room-players");
  list.innerHTML = players
    .map(
      (p) =>
        `<div class="player-item">
          <span class="dot"></span>
          <span>${escHtml(p.name)}</span>
          ${p.id === myPlayerId ? '<span class="self-label">(you)</span>' : ""}
          ${p.id === players[0]?.id ? '<span class="owner-badge">Host</span>' : ""}
        </div>`
    )
    .join("");

  // Show Start button only for room owner
  const startBtn = $("btn-start");
  startBtn.style.display = isOwner ? "" : "none";

  // Replace with one-time listener
  startBtn.onclick = async () => {
    startBtn.disabled = true;
    startBtn.textContent = "Starting...";
    send({ type: "start" });
  };
}

// ── Game Init ──────────────────────────────────────────────────────────────
function initGame() {
  showScreen("game");
  selectedCards = [];
  customPickButtons = [];
  currentPile = null;

  // Merge predefined actions from game.toml into custom pick buttons (dedup by method+count)
  const existingKeys = new Set();
  for (const btn of predefinedActions) {
    const key = getCustomPickKey(btn);
    if (!existingKeys.has(key)) {
      existingKeys.add(key);
      customPickButtons.push({ method: btn.method, count: btn.count });
    }
  }

  // Set first pile as current
  const pileNames = getVisiblePiles();
  currentPile = pileNames[0] || null;

  renderGame();
}

// ── Game State Helpers ─────────────────────────────────────────────────────
function getVisiblePiles() {
  if (!gameState) return [];
  const piles = gameState.G.piles;
  const pileDefs = gameState.G.pileDefs;
  const names = [];

  for (const key of Object.keys(piles)) {
    // Check if this is a player-specific pile
    const baseName = key.includes(":") ? key.split(":")[0] : key;
    const playerSuffix = key.includes(":") ? key.split(":")[1] : null;

    // Only show current player's private piles, and public/base piles
    if (playerSuffix && playerSuffix !== myPlayerId) continue;

    // For base names that reference private piles, only show if the key has the player's suffix
    const def = pileDefs[baseName];
    if (def && def.area === "private" && !key.includes(":")) continue;

    // Deduplicate: if base name has a per-player instance, show the instance, not the bare name
    if (!key.includes(":")) {
      const hasPlayerInstance = Object.keys(piles).some(
        (k) => k.startsWith(key + ":")
      );
      if (hasPlayerInstance) continue;
    }

    names.push(key);
  }

  return names;
}

function getPileLabel(pileKey) {
  if (!gameState) return pileKey;
  const baseName = pileKey.includes(":") ? pileKey.split(":")[0] : pileKey;
  const def = gameState.G.pileDefs[baseName];
  if (def && def.area === "private") {
    return `self:${baseName}`;
  }
  return baseName;
}

function getPileArea(pileKey) {
  if (!gameState) return "public";
  const baseName = pileKey.includes(":") ? pileKey.split(":")[0] : pileKey;
  const def = gameState.G.pileDefs[baseName];
  return def ? def.area : "public";
}

function getPileOrientation(pileKey) {
  if (!gameState) return "down";
  const baseName = pileKey.includes(":") ? pileKey.split(":")[0] : pileKey;
  const def = gameState.G.pileDefs[baseName];
  return def ? def.orientation : "down";
}

function getPileCategory(pileKey) {
  if (!gameState) return "";
  const baseName = pileKey.includes(":") ? pileKey.split(":")[0] : pileKey;
  const def = gameState.G.pileDefs[baseName];
  return def?.category || "";
}

function getCardsInPile(pileKey) {
  if (!gameState) return [];
  const cardIds = gameState.G.piles[pileKey] || [];
  return cardIds.map((id) => ({
    id,
    ...gameState.G.cards[id],
    def: gameState.G.cardDefs[gameState.G.cards[id]?.defId] || {},
  }));
}

function getCardCategory(cardId) {
  const card = gameState?.G.cards[cardId];
  if (!card) return "";
  return gameState.G.cardDefs[card.defId]?.category || "";
}

/**
 * Check whether all selected cards satisfy a target pile's category rule.
 */
function canMoveSelectedToPile(pileKey) {
  const targetCategory = getPileCategory(pileKey);
  if (!targetCategory) return true;
  return selectedCards.every((cardId) => getCardCategory(cardId) === targetCategory);
}

// ── Render Game ────────────────────────────────────────────────────────────
function renderGame() {
  if (!gameState) return;

  // Header — game name left, player middle, turn right
  $("game-name-display").textContent = window._gameName || "Game";
  const playerName = players.find(p => p.id === myPlayerId)?.name || "";
  $("game-player-display").textContent = playerName ? formatPlayerName(playerName) : "";
  $("game-info-display").textContent = `Turn ${gameState.ctx.turn}`;

  // History
  renderHistory();

  // Pile Tabs
  renderPileTabs();

  // Card Area
  renderCardArea();

  // Action Bar
  renderActionBar();
}

function renderHistory() {
  const container = $("game-history");
  const entries = historyEntries;

  if (entries.length === 0) {
    container.innerHTML = '<div class="history-entry empty">No actions yet</div>';
    return;
  }

  // Show at least (players.length + 1) entries, or last 20, whichever is larger
  const minLines = Math.max(players.length + 1, 5);
  const showCount = Math.max(minLines, 20);
  const recent = entries.slice(-showCount);
  // Calculate global index of the first entry in `recent`
  const offset = Math.max(0, entries.length - showCount);
  container.innerHTML = recent
    .map((e, i) => {
      const isNew = offset + i >= knownHistoryLength;
      // Highlight pile names and card names in the detail text
      const detailHtml = highlightDetail(e.detail);
      return `<div class="history-entry ${isNew ? "new" : ""}">
        <span class="time">${formatTime(e.timestamp)}</span>
        <span class="player">${escHtml(e.playerName)}</span>
        <span class="detail-text">${detailHtml}</span>
      </div>`;
    })
    .join("");

  // Auto-scroll to bottom
  container.scrollTop = container.scrollHeight;
}

function renderPileTabs() {
  const container = $("pile-tabs");
  const pileNames = getVisiblePiles();
  const publicPiles = pileNames.filter((key) => getPileArea(key) === "public");
  const privatePiles = pileNames.filter((key) => getPileArea(key) === "private");

  const renderTab = (key) => `
    <button class="pile-tab ${getPileArea(key)} ${key === currentPile ? "active" : ""}"
            data-pile="${key}">
      ${escHtml(getPileLabel(key))}
    </button>
  `;

  const publicHtml = publicPiles.map(renderTab).join("");
  const privateHtml = privatePiles.map(renderTab).join("");
  container.innerHTML = `
    ${publicPiles.length > 0 ? `<div class="pile-tab-group public-tabs">${publicHtml}</div>` : ""}
    ${publicPiles.length > 0 && privatePiles.length > 0 ? '<div class="pile-tab-separator" aria-hidden="true"></div>' : ""}
    ${privatePiles.length > 0 ? `<div class="pile-tab-group private-tabs">${privateHtml}</div>` : ""}
  `;

  // Click handlers
  container.querySelectorAll(".pile-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      currentPile = btn.dataset.pile;
      selectedCards = []; // clear selection when switching piles
      lastPickMethod = null;
      renderGame();
      restartAnimation($("card-area"), "view-enter");
    });
  });
}

function renderCardArea() {
  const container = $("card-area");
  renderPileViewModeButton(false);
  container.classList.remove("tight-view");
  renderPileCardCount(0);
  if (!currentPile) {
    container.innerHTML = '<div class="card-face empty-pile full-area">Select a pile</div>';
    return;
  }

  const cards = getCardsInPile(currentPile);
  renderPileCardCount(cards.length);
  const orientation = getPileOrientation(currentPile);

  // Pile orientation is authoritative: a face-down pile hides card content
  // even when the pile belongs to the current player.
  const showUp = orientation === "up";

  if (cards.length === 0) {
    container.innerHTML = '<div class="card-face empty-pile full-width">Empty pile</div>';
    return;
  }

  if (!showUp) {
    // ── Face-down stack: show as a single stacked pile ──────────────────
    container.innerHTML = `
      <div class="stacked-pile" id="stacked-pile">
        <button class="stacked-cards" type="button" aria-label="Touch face-down pile">
          <div class="stack-card stack-card-1"></div>
          <div class="stack-card stack-card-2"></div>
          <div class="stack-card stack-card-3 stack-front">
            <span class="stack-suit">♠</span>
          </div>
        </button>
        <div class="stack-label">${escHtml(getPileLabel(currentPile))}</div>
      </div>
    `;
    const stack = $("stacked-pile")?.querySelector(".stacked-cards");
    stack?.addEventListener("click", () => registerTapFeedback(stack));
    return;
  }

  // ── Face-up pile: show individual cards ──────────────────────────────
  const isTight = faceUpPileViewMode === "tight";
  container.classList.toggle("tight-view", isTight);
  renderPileViewModeButton(true);
  container.innerHTML = cards
    .map((card) => {
      const isSelected = selectedCards.includes(card.id);
      const name = card.def?.name || card.defId || "?";
      const corner = card.def?.corner || "";
      const center = card.def?.center || "";

      if (isTight) {
        return `<div class="card-face up tight-card ${isSelected ? "selected" : ""}" data-card-id="${card.id}">
          <span class="tight-card-name">${escHtml(name)}</span>
        </div>`;
      }

      return `<div class="card-face up ${isSelected ? "selected" : ""}" data-card-id="${card.id}">
        ${renderCardFaceSlot(corner, "corner")}
        ${renderCardFaceSlot(center, "center")}
        <span class="name-label">${escHtml(name)}</span>
      </div>`;
    })
    .join("");

  // Click to toggle selection
  container.querySelectorAll(".card-face[data-card-id]").forEach((el) => {
    el.addEventListener("click", () => {
      registerTapFeedback(el);
      const cardId = el.dataset.cardId;
      toggleCardSelection(cardId);
    });
  });
}

/**
 * Render a card face slot as either an image asset or plain text.
 * Image paths are relative to the running game directory and served by the
 * server through the read-only game asset route.
 */
function renderCardFaceSlot(value, slotName) {
  const text = String(value || "").trim();
  if (!text) return "";

  if (isImagePath(text)) {
    return `<img class="${slotName} card-face-image" src="${gameAssetUrl(text)}" alt="">`;
  }

  return `<span class="${slotName}">${escHtml(text)}</span>`;
}

/**
 * Treat common image filenames as paths. Other values, including short marks
 * like "A" or "♣️3", remain plain display text.
 */
function isImagePath(value) {
  return /\.(png|jpe?g|gif|webp|svg|avif)$/i.test(value.trim());
}

function gameAssetUrl(relativePath) {
  const encodedPath = relativePath
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  return `/game-assets/${encodeURIComponent(activeGameId)}/${encodedPath}`;
}

/**
 * Render the face-up pile display toggle at the top-right of the table.
 * The mode is local UI state; game state and card order are unchanged.
 */
function renderPileViewModeButton(visible) {
  const stage = document.querySelector(".table-stage");
  const existing = document.querySelector(".pile-view-mode-btn");
  if (existing) existing.remove();
  if (!visible || !stage) return;

  const nextMode = faceUpPileViewMode === "normal" ? "tight" : "normal";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `pile-view-mode-btn ${faceUpPileViewMode === "tight" ? "active" : ""}`;
  btn.title = `Switch to ${nextMode} view`;
  btn.setAttribute("aria-label", `Switch to ${nextMode} view`);
  btn.setAttribute("aria-pressed", String(faceUpPileViewMode === "tight"));
  btn.textContent = "↻";
  btn.addEventListener("click", () => {
    faceUpPileViewMode = nextMode;
    renderCardArea();
  });
  stage.appendChild(btn);
}

/**
 * Render a card info button at bottom-right of the table stage.
 * Only shown when exactly 1 face-up card is selected.
 */
function renderCardInfoButton() {
  // Remove any existing info button
  const existing = document.querySelector(".card-info-btn");
  if (existing) existing.remove();

  // Show info button only when exactly 1 card selected on a face-up pile
  if (selectedCards.length !== 1) return;
  if (!currentPile) return;
  if (getPileOrientation(currentPile) !== "up") return;

  const stage = document.querySelector(".table-stage");
  if (!stage) return;

  const btn = document.createElement("button");
  btn.className = "card-info-btn";
  btn.type = "button";
  btn.textContent = "i";
  btn.setAttribute("aria-label", "Show card info");

  btn.addEventListener("click", () => {
    const cardId = selectedCards[0];
    const card = gameState?.G.cards[cardId];
    if (!card) return;
    const def = gameState?.G.cardDefs[card.defId];
    const name = def?.name || card.defId || "?";
    const description = def?.description || "No description.";
    $("card-info-title").textContent = name;
    $("card-info-body").innerHTML = `<p>${escHtml(description)}</p>`;
    $("card-info-modal").classList.remove("hidden");
    $("btn-card-info-close").focus();
  });

  stage.appendChild(btn);
}

function renderActionBar() {
  const container = $("action-bar");

  // If cards are selected, always show Mode B (move targets)
  if (selectedCards.length > 0) {
    renderModeB(container);
    restartAnimation(container, "panel-enter");
    renderCardInfoButton();
    return;
  }

  // Mode A: No cards selected — show pile operations
  renderModeA(container);
  restartAnimation(container, "panel-enter");
  // Remove any lingering card info button
  const infoBtn = document.querySelector(".card-info-btn");
  if (infoBtn) infoBtn.remove();
}

function renderModeA(container) {
  if (!currentPile) {
    container.innerHTML = "";
    return;
  }

  const cards = getCardsInPile(currentPile);
  if (cards.length === 0) {
    container.innerHTML = "";
    return;
  }

  container.innerHTML = `
    <div class="pile-actions">
      <span class="action-label">From ${escHtml(getPileLabel(currentPile))}</span>
      <button class="action-btn" data-action="pick-top-1">Top ×1</button>
      <button class="action-btn" data-action="pick-random-1">Rand ×1</button>
      <button class="action-btn" data-action="pick-all">All</button>
      <button class="action-btn add-action-btn" data-action="open-custom-picker" aria-label="Add pick button">+</button>
      <button class="action-btn add-action-btn" data-action="open-delete-custom-picker" aria-label="Delete pick buttons">−</button>
      ${customPickButtons
        .map(
          (button) =>
            `<button class="action-btn" data-action="pick-saved" data-method="${button.method}" data-count="${button.count}">
              ${formatPickButtonLabel(button.method, button.count)}
            </button>`
        )
        .join("")}
      <button class="action-btn warning" data-action="shuffle">Shuffle</button>
      <button class="action-btn warning" data-action="sort">Sort</button>
    </div>
  `;

  container.querySelectorAll("[data-action]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const action = btn.dataset.action;
      switch (action) {
        case "pick-top-1":
          pickFromCurrent("top", 1);
          break;
        case "pick-random-1":
          pickFromCurrent("random", 1);
          break;
        case "open-custom-picker":
          openCustomPickModal();
          break;
        case "open-delete-custom-picker":
          openDeleteCustomPickModal();
          break;
        case "pick-saved":
          pickFromCurrent(btn.dataset.method, Number(btn.dataset.count));
          break;
        case "pick-all":
          pickFromCurrent("all", cards.length);
          break;
        case "shuffle":
          openConfirmModal("Shuffle pile", `Shuffle ${getPileLabel(currentPile)}?`, () => {
            send({ type: "shuffle", pile: currentPile });
          });
          break;
        case "sort":
          openConfirmModal("Sort pile", `Sort ${getPileLabel(currentPile)}?`, () => {
            send({ type: "sort", pile: currentPile });
          });
          break;
      }
    });
  });
}

function renderModeB(container) {
  const pileNames = getVisiblePiles();
  const targetPiles = pileNames.filter((p) => p !== currentPile);

  container.innerHTML = `
    <div class="selection-info">
      <span>Selected ${selectedCards.length} card(s)</span>
      <button class="action-btn warning" data-action="cancel">Cancel</button>
    </div>
    <div class="pile-actions">
      <span class="action-label">Move to:</span>
      ${targetPiles
        .map((p) => {
          const isAllowed = canMoveSelectedToPile(p);
          const area = getPileArea(p);
          const category = getPileCategory(p);
          const title = isAllowed ? "" : ` title="Only ${escHtml(category)} cards can move here"`;
          return `<button class="action-btn target-pile ${area}" data-action="move-to" data-target="${p}" ${isAllowed ? "" : "disabled"}${title}>
              ${escHtml(getPileLabel(p))}
            </button>`;
        })
        .join("")}
    </div>
  `;

  container.querySelectorAll("[data-action='cancel']").forEach((btn) => {
    btn.addEventListener("click", () => {
      selectedCards = [];
      lastPickMethod = null;
      renderGame();
    });
  });

  container.querySelectorAll("[data-action='move-to']").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = btn.dataset.target;
      commitMove(target);
    });
  });
}

/**
 * Send a move command immediately and play a fixed tabletop effect.
 */
function commitMove(target) {
  if (!currentPile || selectedCards.length === 0) return;
  if (!canMoveSelectedToPile(target)) {
    const category = getPileCategory(target);
    showToast(`${getPileLabel(target)} only accepts ${category} cards`);
    return;
  }

  const from = currentPile;
  const cardIds = [...selectedCards];
  const pickMethod = lastPickMethod;
  send({
    type: "move",
    action: {
      from,
      to: target,
      cardIds,
      playerId: myPlayerId,
      pickMethod,
    },
  });
  selectedCards = [];
  lastPickMethod = null;
  renderGame();
}

// ── Card Selection ─────────────────────────────────────────────────────────
function toggleCardSelection(cardId) {
  lastPickMethod = null;
  const idx = selectedCards.indexOf(cardId);
  if (idx >= 0) {
    selectedCards.splice(idx, 1);
  } else {
    selectedCards.push(cardId);
  }
  renderGame();
}

function pickFromCurrent(method, count) {
  if (!currentPile) return;
  const cards = getCardsInPile(currentPile);
  const safeCount = Math.max(0, Math.min(count, cards.length));

  let picked = [];
  if (method === "all") {
    picked = cards.map((c) => c.id);
  } else if (method === "top") {
    picked = cards.slice(-safeCount).map((c) => c.id);
  } else if (method === "random") {
    const shuffled = [...cards].sort(() => Math.random() - 0.5);
    picked = shuffled.slice(0, safeCount).map((c) => c.id);
  }

  selectedCards = picked;
  lastPickMethod = method;
  renderGame();
}

/**
 * Open the custom picker modal with counts capped to the current pile size.
 */
function openCustomPickModal() {
  if (!currentPile) return;
  const cards = getCardsInPile(currentPile);
  if (cards.length === 0) return;

  customPickDraftMethod = "top";
  customPickDraftCount = 2;
  syncCustomPickDraftUi();
  $("custom-pick-modal").classList.remove("hidden");
  $("custom-method-top").focus();
}

/**
 * Save a custom pick button for the current browser game session.
 */
function saveCustomPickButton() {
  const method = customPickDraftMethod;
  const count = customPickDraftCount;
  if (!["top", "random"].includes(method) || !Number.isSafeInteger(count) || count < 2 || count > 20) {
    showToast("Choose a valid pick");
    return;
  }

  const exists = customPickButtons.some((button) => (
    button.method === method && button.count === count
  ));
  if (exists) {
    showToast("This pick button already exists");
    return;
  }
  customPickButtons.push({ method, count });

  closeCustomPickModal();
  renderGame();
}

/**
 * Close the custom picker modal without changing saved buttons.
 */
function closeCustomPickModal() {
  $("custom-pick-modal").classList.add("hidden");
}

function syncCustomPickDraftUi() {
  const range = $("custom-pick-range");
  $("custom-method-top").classList.toggle("active", customPickDraftMethod === "top");
  $("custom-method-random").classList.toggle("active", customPickDraftMethod === "random");
  range.value = String(customPickDraftCount);
  $("custom-pick-count-value").textContent = String(customPickDraftCount);
  syncRangeFill(range);
}

/**
 * Fill only the left side of a range input up to the current thumb position.
 */
function syncRangeFill(range) {
  const min = Number(range.min || 0);
  const max = Number(range.max || 100);
  const value = Number(range.value || min);
  const fill = max > min ? ((value - min) / (max - min)) * 100 : 0;
  range.style.setProperty("--range-fill", `${fill}%`);
}

$("custom-method-top").addEventListener("click", () => {
  customPickDraftMethod = "top";
  syncCustomPickDraftUi();
});

$("custom-method-random").addEventListener("click", () => {
  customPickDraftMethod = "random";
  syncCustomPickDraftUi();
});

$("custom-pick-range").addEventListener("input", (e) => {
  customPickDraftCount = Number(e.target.value);
  syncCustomPickDraftUi();
});

function openDeleteCustomPickModal() {
  renderDeleteCustomPickList();
  $("delete-custom-pick-modal").classList.remove("hidden");
  $("btn-delete-custom-cancel").focus();
}

function closeDeleteCustomPickModal() {
  $("delete-custom-pick-modal").classList.add("hidden");
}

function renderDeleteCustomPickList() {
  const list = $("delete-custom-list");
  if (customPickButtons.length === 0) {
    list.innerHTML = '<div class="empty-delete-list">No custom buttons</div>';
    return;
  }

  list.innerHTML = customPickButtons
    .map((button) => {
      const key = getCustomPickKey(button);
      return `<button class="delete-pick-option" type="button" data-delete-key="${escHtml(key)}">
        ${escHtml(formatPickButtonLabel(button.method, button.count))}
      </button>`;
    })
    .join("");

  list.querySelectorAll(".delete-pick-option").forEach((btn) => {
    btn.addEventListener("click", () => {
      btn.classList.toggle("selected");
    });
  });
}

function deleteSelectedCustomPickButtons() {
  const selectedKeys = Array.from(
    $("delete-custom-list").querySelectorAll(".delete-pick-option.selected"),
  ).map((btn) => btn.dataset.deleteKey);
  if (selectedKeys.length === 0) {
    showToast("Select buttons to delete");
    return;
  }

  const selected = new Set(selectedKeys);
  customPickButtons = customPickButtons.filter((button) => !selected.has(getCustomPickKey(button)));
  closeDeleteCustomPickModal();
  renderGame();
}

function getCustomPickKey(button) {
  return `${button.method}:${button.count}`;
}

function openConfirmModal(title, body, onConfirm) {
  pendingConfirmAction = onConfirm;
  $("confirm-title").textContent = title;
  $("confirm-body").textContent = body;
  $("confirm-modal").classList.remove("hidden");
  $("btn-confirm-ok").focus();
}

function runPendingConfirmAction() {
  const action = pendingConfirmAction;
  closeConfirmModal();
  if (action) {
    action();
  }
}

function closeConfirmModal() {
  pendingConfirmAction = null;
  $("confirm-modal").classList.add("hidden");
}

function openHelpModal() {
  $("help-title").textContent = `${window._gameName || "Game"}`;
  $("help-content").textContent = window._gameHelp || "No help has been configured for this game.";
  $("help-modal").classList.remove("hidden");
  $("btn-help-close").focus();
}

function closeHelpModal() {
  $("help-modal").classList.add("hidden");
}

// ── Card Info Modal ─────────────────────────────────────────────────────────
function closeCardInfoModal() {
  $("card-info-modal").classList.add("hidden");
}

function formatPickButtonLabel(method, count) {
  const label = method === "random" ? "Rand" : "Top";
  return `${label} ×${count}`;
}

// ── Utilities ──────────────────────────────────────────────────────────────
/**
 * Add a short visual and haptic pulse for high-frequency mobile taps.
 */
function registerTapFeedback(el) {
  el.classList.remove("tap-fired");
  // Restart the animation even when the same control is tapped repeatedly.
  void el.offsetWidth;
  el.classList.add("tap-fired");

  if (navigator.vibrate) {
    navigator.vibrate(8);
  }
}

/**
 * Restart a CSS animation class on demand.
 */
function restartAnimation(el, className) {
  if (!el) return;
  el.classList.remove(className);
  void el.offsetWidth;
  el.classList.add(className);
}

function escHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function formatPlayerName(name) {
  return `player: ${name}`;
}

function renderPileCardCount(count) {
  const el = $("pile-card-count");
  if (!el) return;
  el.textContent = currentPile ? `${count} cards` : "";
}

/**
 * Play a short table-level effect for the latest shared action.
 */
function playActionEffect(entry) {
  if (!entry) return;
  const layer = $("action-effect-layer");
  if (!layer) return;

  const action = entry.action || "";
  const isMove = action === "move";
  const isShuffle = action === "shuffle";
  const isSort = action === "sort";
  if (!isMove && !isShuffle && !isSort) return;

  if (actionEffectTimeout) {
    clearTimeout(actionEffectTimeout);
  }

  const ownAction = entry.playerId === myPlayerId || !entry.playerId;
  const label = ownAction ? formatActionLabel(action) : `${entry.playerName} ${action}`;
  const cards = isSort ? 4 : isShuffle ? 5 : 3;
  layer.className = `action-effect-layer ${action}-effect`;
  layer.innerHTML = `
    <div class="effect-burst" aria-hidden="true">
      ${Array.from({ length: cards }, (_, i) => `<span class="effect-card effect-card-${i + 1}"></span>`).join("")}
      <span class="effect-label">${escHtml(label)}</span>
    </div>
  `;

  actionEffectTimeout = setTimeout(() => {
    layer.className = "action-effect-layer";
    layer.innerHTML = "";
  }, 920);
}

function formatActionLabel(action) {
  if (action === "move") return "Move";
  if (action === "shuffle") return "Shuffle";
  if (action === "sort") return "Sort";
  return action;
}

/**
 * Highlight pile names and card names in the detail text with coloured spans.
 */
function highlightDetail(detail) {
  let text = detail;
  // Highlight pile names (words that appear after "from" or "to" or "Shuffled" or "Sorted")
  text = text.replace(/\b(from|to|Shuffled|Sorted)\s+([:\w]+)/g, (match, p1, p2) => {
    return `${p1} <span class="highlight-pile">${escHtml(p2)}</span>`;
  });
  // Highlight card names (comma-separated words after a colon)
  text = text.replace(/(:\s)([^:]+)$/, (match, colon, names) => {
    const highlightedNames = names.split(", ").map(n => {
      const trimmed = n.trim();
      return `<span class="highlight-card">${escHtml(trimmed)}</span>`;
    }).join(", ");
    return `${colon}${highlightedNames}`;
  });
  return text;
}

function formatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function showToast(msg) {
  const existing = document.querySelector(".toast");
  if (existing) existing.remove();
  if (toastTimeout) clearTimeout(toastTimeout);

  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  document.body.appendChild(el);

  toastTimeout = setTimeout(() => {
    el.remove();
  }, 3000);
}

/**
 * Fetch static game metadata before any room is created.
 */
async function loadGameMetadata() {
  try {
    const res = await fetch("/config.json");
    if (!res.ok) return;
    const config = await res.json();
    availableGames = Array.isArray(config.games) ? config.games : [];
    if (availableGames.length === 1) {
      selectLobbyGame(availableGames[0].id);
    } else {
      $("lobby-game").value = "Choose a game";
    }
  } catch {
    // The websocket flow still supplies the game name after a room starts.
  }
}

/**
 * Update every visible place that displays the current game name.
 */
function updateGameName(name) {
  if (!name) return;
  window._gameName = name;
  $("game-name-display").textContent = name;
}

/** Show the game-picker dialog only when the server has multiple games. */
function openGamePicker() {
  if (availableGames.length < 2) return;
  const list = $("game-picker-list");
  list.innerHTML = availableGames.map((game) => `
    <button class="game-picker-option ${game.id === selectedGameId ? "selected" : ""}" type="button" data-game-id="${escHtml(game.id)}">
      ${escHtml(game.name)}
    </button>
  `).join("");
  list.querySelectorAll(".game-picker-option").forEach((button) => {
    button.addEventListener("click", () => {
      selectLobbyGame(button.dataset.gameId);
      closeGamePicker();
    });
  });
  $("game-picker-modal").classList.remove("hidden");
}

/** Set the game used by the next newly created room. */
function selectLobbyGame(gameId) {
  const game = availableGames.find((candidate) => candidate.id === gameId);
  if (!game) return;
  selectedGameId = game.id;
  $("lobby-game").value = game.name;
}

function closeGamePicker() {
  $("game-picker-modal").classList.add("hidden");
}

function updateGameHelp(help) {
  if (typeof help !== "string") return;
  window._gameHelp = help;
}

// ── Init ───────────────────────────────────────────────────────────────────
loadGameMetadata();
applyInviteLink();
updateResumeButton();
connect();
