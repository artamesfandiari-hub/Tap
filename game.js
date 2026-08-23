const tg = window.Telegram?.WebApp;

if (tg) {
  tg.ready();
  tg.expand();
}

const state = {
  socket: null,
  connected: false,
  room: null,
  user: null,
  pingTimer: null,
  reconnectTimer: null,
  reconnectAttempts: 0,
  game: {
    score: 0,
    opponentScore: 0,
    time: 30,
    running: false,
    timer: null
  }
};

const homeScreen = document.getElementById("homeScreen");
const roomScreen = document.getElementById("roomScreen");
const gameScreen = document.getElementById("gameScreen");
const resultScreen = document.getElementById("resultScreen");

const connectionStatus = document.getElementById("connectionStatus");

const createButton = document.getElementById("createButton");
const joinButton = document.getElementById("joinButton");
const roomCodeInput = document.getElementById("roomCode");

const roomCodeDisplay = document.getElementById("roomCodeDisplay");
const roomMessage = document.getElementById("roomMessage");

const player1Name = document.getElementById("player1Name");
const player1Status = document.getElementById("player1Status");

const player2Name = document.getElementById("player2Name");
const player2Status = document.getElementById("player2Status");

const readyButton = document.getElementById("readyButton");
const leaveButton = document.getElementById("leaveButton");

const gamePlayerName = document.getElementById("gamePlayerName");
const gameTimer = document.getElementById("gameTimer");
const gameScore = document.getElementById("gameScore");
const opponentScore = document.getElementById("opponentScore");

const tapButton = document.getElementById("tapButton");

const resultTitle = document.getElementById("resultTitle");
const resultScore = document.getElementById("resultScore");
const backHomeButton = document.getElementById("backHomeButton");

const toast = document.getElementById("toast");

function getInitData() {
  return tg?.initData || "";
}

function getTelegramUser() {
  if (!tg?.initDataUnsafe?.user) {
    return {
      id: "local",
      first_name: "Player",
      username: ""
    };
  }

  return tg.initDataUnsafe.user;
}

function showScreen(screen) {
  [
    homeScreen,
    roomScreen,
    gameScreen,
    resultScreen
  ].forEach(item => {
    item.classList.remove("active");
  });

  screen.classList.add("active");
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");

  clearTimeout(showToast.timer);

  showToast.timer = setTimeout(() => {
    toast.classList.remove("show");
  }, 2500);
}

function setConnection(online) {
  state.connected = online;

  if (online) {
    connectionStatus.textContent = "ONLINE";
    connectionStatus.classList.remove("offline");
    connectionStatus.classList.add("online");
  } else {
    connectionStatus.textContent = "OFFLINE";
    connectionStatus.classList.remove("online");
    connectionStatus.classList.add("offline");
  }
}

function apiHeaders() {
  return {
    "Content-Type": "application/json",
    "X-Telegram-Init-Data": getInitData()
  };
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...apiHeaders(),
      ...(options.headers || {})
    }
  });

  const data = await response.json().catch(() => ({
    ok: false,
    error: "INVALID_SERVER_RESPONSE"
  }));

  if (!response.ok || data.ok === false) {
    throw new Error(data.error || "REQUEST_FAILED");
  }

  return data;
}

function getWebSocketUrl() {
  const protocol =
    location.protocol === "https:"
      ? "wss:"
      : "ws:";

  return (
    `${protocol}//${location.host}/ws` +
    `?initData=${encodeURIComponent(getInitData())}`
  );
}

function connectSocket() {
  if (!getInitData()) {
    setConnection(false);
    showToast("Telegram session data is unavailable.");
    return;
  }

  if (
    state.socket &&
    (
      state.socket.readyState === WebSocket.OPEN ||
      state.socket.readyState === WebSocket.CONNECTING
    )
  ) {
    return;
  }

  clearTimeout(state.reconnectTimer);

  try {
    state.socket = new WebSocket(getWebSocketUrl());
  } catch {
    scheduleReconnect();
    return;
  }

  state.socket.addEventListener("open", () => {
    state.reconnectAttempts = 0;
    setConnection(true);

    if (state.room?.code) {
      state.socket.send(JSON.stringify({
        type: "join_room",
        code: state.room.code
      }));
    }

    clearInterval(state.pingTimer);

    state.pingTimer = setInterval(() => {
      if (
        state.socket &&
        state.socket.readyState === WebSocket.OPEN
      ) {
        state.socket.send(JSON.stringify({
          type: "ping"
        }));
      }
    }, 20000);
  });

  state.socket.addEventListener("message", event => {
    handleSocketMessage(event.data);
  });

  state.socket.addEventListener("close", () => {
    setConnection(false);

    clearInterval(state.pingTimer);

    scheduleReconnect();
  });

  state.socket.addEventListener("error", () => {
    setConnection(false);
  });
}

function scheduleReconnect() {
  clearTimeout(state.reconnectTimer);

  state.reconnectAttempts++;

  const delay = Math.min(
    1000 * Math.pow(1.5, state.reconnectAttempts),
    10000
  );

  state.reconnectTimer = setTimeout(() => {
    connectSocket();
  }, delay);
}

function sendSocket(message) {
  if (
    !state.socket ||
    state.socket.readyState !== WebSocket.OPEN
  ) {
    showToast("Connection is not ready.");
    return false;
  }

  state.socket.send(JSON.stringify(message));

  return true;
}

function handleSocketMessage(raw) {
  let message;

  try {
    message = JSON.parse(raw);
  } catch {
    return;
  }

  if (message.type === "connected") {
    state.user = message.user;
    return;
  }

  if (message.type === "pong") {
    return;
  }

  if (message.type === "room_created") {
    state.room = message.room;

    renderRoom();

    showScreen(roomScreen);

    return;
  }

  if (message.type === "room_state") {
    state.room = message.room;

    renderRoom();

    if (state.room.status === "ready") {
      roomMessage.textContent =
        "Both players are connected. Press READY when you are ready.";
    }

    return;
  }

  if (message.type === "player_connection") {
    renderRoom();
    return;
  }

  if (message.type === "left_room") {
    state.room = null;

    showScreen(homeScreen);

    return;
  }

  if (message.type === "room_expired") {
    state.room = null;

    showScreen(homeScreen);

    showToast("This room has expired.");

    return;
  }

  if (message.type === "error") {
    handleError(message.error);
  }
}

function handleError(error) {
  const messages = {
    ROOM_NOT_FOUND: "Room not found.",
    ROOM_FULL: "This room is already full.",
    INVALID_ROOM_CODE: "Room code must contain six digits.",
    INVALID_TELEGRAM_DATA: "Telegram session is invalid.",
    ALREADY_IN_ROOM: "You are already inside a room.",
    NOT_IN_ROOM: "You are not inside a room.",
    PLAYER_NOT_IN_ROOM: "Player was not found in this room.",
    INVALID_MESSAGE: "Invalid server message."
  };

  showToast(messages[error] || "Something went wrong.");
}

function renderRoom() {
  if (!state.room) {
    return;
  }

  roomCodeDisplay.textContent = state.room.code;

  const players = state.room.players || [];

  const p1 = players[0] || null;
  const p2 = players[1] || null;

  player1Name.textContent =
    p1?.name || "WAITING";

  player2Name.textContent =
    p2?.name || "WAITING";

  player1Status.textContent =
    getPlayerStatus(p1);

  player2Status.textContent =
    getPlayerStatus(p2);

  const currentPlayer = players.find(
    player => String(player.id) === String(state.user?.id)
  );

  if (currentPlayer?.ready) {
    readyButton.textContent = "READY";
    readyButton.disabled = true;
  } else {
    readyButton.textContent = "READY";
    readyButton.disabled =
      players.length !== 2;
  }

  if (players.length < 2) {
    roomMessage.textContent =
      "Waiting for another player to join.";
  } else if (
    players.every(player => player.ready)
  ) {
    roomMessage.textContent =
      "Both players are ready. The match can start.";
  } else {
    roomMessage.textContent =
      "Both players are connected. Press READY when you are ready.";
  }
}

function getPlayerStatus(player) {
  if (!player) {
    return "WAITING";
  }

  if (!player.connected) {
    return "DISCONNECTED";
  }

  if (player.ready) {
    return "READY";
  }

  return "CONNECTED";
}

async function createRoom() {
  createButton.disabled = true;

  try {
    const data = await api("/api/room/create", {
      method: "POST"
    });

    state.room = data.room;

    showScreen(roomScreen);

    renderRoom();

    connectSocket();

    if (
      state.socket &&
      state.socket.readyState === WebSocket.OPEN
    ) {
      sendSocket({
        type: "join_room",
        code: state.room.code
      });
    }
  } catch (error) {
    handleError(error.message);
  } finally {
    createButton.disabled = false;
  }
}

async function joinRoom() {
  const code = roomCodeInput.value.trim();

  if (!/^\d{6}$/.test(code)) {
    showToast("Enter a valid six-digit room code.");
    return;
  }

  joinButton.disabled = true;

  try {
    const data = await api("/api/room/join", {
      method: "POST",
      body: JSON.stringify({
        code
      })
    });

    state.room = data.room;

    showScreen(roomScreen);

    renderRoom();

    connectSocket();

    if (
      state.socket &&
      state.socket.readyState === WebSocket.OPEN
    ) {
      sendSocket({
        type: "join_room",
        code
      });
    }
  } catch (error) {
    handleError(error.message);
  } finally {
    joinButton.disabled = false;
  }
}

function leaveRoom() {
  if (state.room?.code) {
    sendSocket({
      type: "leave_room"
    });
  }

  state.room = null;

  showScreen(homeScreen);
}

function toggleReady() {
  if (!state.room) {
    return;
  }

  sendSocket({
    type: "ready",
    value: true
  });
}

function startGame() {
  if (!state.room) {
    return;
  }

  const players = state.room.players || [];

  if (players.length !== 2) {
    return;
  }

  if (!players.every(player => player.ready)) {
    return;
  }

  state.game.score = 0;
  state.game.opponentScore = 0;
  state.game.time = 30;
  state.game.running = true;

  gamePlayerName.textContent =
    state.user?.name || "PLAYER";

  gameTimer.textContent = "30";
  gameScore.textContent = "0";
  opponentScore.textContent = "0";

  showScreen(gameScreen);

  clearInterval(state.game.timer);

  state.game.timer = setInterval(() => {
    state.game.time--;

    gameTimer.textContent =
      String(Math.max(state.game.time, 0));

    if (state.game.time <= 0) {
      endGame();
    }
  }, 1000);
}

function tap() {
  if (!state.game.running) {
    return;
  }

  state.game.score++;

  gameScore.textContent =
    String(state.game.score);

  sendSocket({
    type: "tap",
    score: state.game.score
  });
}

function endGame() {
  if (!state.game.running) {
    return;
  }

  state.game.running = false;

  clearInterval(state.game.timer);

  const myScore = state.game.score;
  const otherScore = state.game.opponentScore;

  resultScore.textContent =
    `${myScore} — ${otherScore}`;

  if (myScore > otherScore) {
    resultTitle.textContent = "YOU WIN";
  } else if (myScore < otherScore) {
    resultTitle.textContent = "YOU LOSE";
  } else {
    resultTitle.textContent = "DRAW";
  }

  showScreen(resultScreen);
}

function backHome() {
  state.game.running = false;

  clearInterval(state.game.timer);

  if (state.room) {
    leaveRoom();
  } else {
    showScreen(homeScreen);
  }
}

createButton.addEventListener("click", createRoom);

joinButton.addEventListener("click", joinRoom);

roomCodeInput.addEventListener("input", () => {
  roomCodeInput.value =
    roomCodeInput.value.replace(/\D/g, "").slice(0, 6);
});

roomCodeInput.addEventListener("keydown", event => {
  if (event.key === "Enter") {
    joinRoom();
  }
});

readyButton.addEventListener("click", () => {
  toggleReady();
});

leaveButton.addEventListener("click", () => {
  leaveRoom();
});

tapButton.addEventListener("pointerdown", event => {
  event.preventDefault();
  tap();
});

backHomeButton.addEventListener("click", () => {
  backHome();
});

setInterval(() => {
  if (
    state.room &&
    state.room.status === "ready"
  ) {
    const players = state.room.players || [];

    if (
      players.length === 2 &&
      players.every(player => player.ready)
    ) {
      startGame();
    }
  }
}, 250);

state.user = getTelegramUser();

connectSocket();
