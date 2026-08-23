const express = require("express");
const http = require("http");
const crypto = require("crypto");
const WebSocket = require("ws");

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || "";
const MINI_APP_URL = process.env.MINI_APP_URL || "";

const wss = new WebSocket.Server({
  server,
  path: "/ws"
});

app.use(express.json());
app.use(express.static(__dirname));

const rooms = new Map();
const sockets = new Map();

const ROOM_TTL = 30 * 60 * 1000;
const PLAYER_TIMEOUT = 60 * 1000;

function json(res, status, data) {
  res.status(status).json(data);
}

function randomRoomCode() {
  let code;

  do {
    code = String(Math.floor(100000 + Math.random() * 900000));
  } while (rooms.has(code));

  return code;
}

function now() {
  return Date.now();
}

function makePlayer(user) {
  return {
    id: String(user.id),
    name: user.name || "Player",
    username: user.username || "",
    joinedAt: now(),
    lastSeen: now(),
    connected: false,
    ready: false,
    score: 0
  };
}

function sanitizeName(name) {
  if (!name) return "Player";

  return String(name)
    .replace(/[<>]/g, "")
    .slice(0, 40);
}

function getTelegramUserFromInitData(initData) {
  if (!initData || !BOT_TOKEN) {
    return null;
  }

  try {
    const params = new URLSearchParams(initData);
    const hash = params.get("hash");

    if (!hash) {
      return null;
    }

    params.delete("hash");

    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join("\n");

    const secretKey = crypto
      .createHmac("sha256", "WebAppData")
      .update(BOT_TOKEN)
      .digest();

    const calculatedHash = crypto
      .createHmac("sha256", secretKey)
      .update(dataCheckString)
      .digest("hex");

    if (calculatedHash !== hash) {
      return null;
    }

    const authDate = Number(params.get("auth_date"));

    if (!authDate) {
      return null;
    }

    if (Math.floor(Date.now() / 1000) - authDate > 86400) {
      return null;
    }

    const userRaw = params.get("user");

    if (!userRaw) {
      return null;
    }

    return JSON.parse(userRaw);
  } catch {
    return null;
  }
}

function getRoomState(room) {
  return {
    code: room.code,
    status: room.status,
    createdBy: room.createdBy,
    players: [...room.players.values()].map(player => ({
      id: player.id,
      name: player.name,
      username: player.username,
      connected: player.connected,
      ready: player.ready,
      score: player.score
    }))
  };
}

function sendSocket(socket, payload) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return;
  }

  socket.send(JSON.stringify(payload));
}

function broadcastRoom(room, payload) {
  for (const player of room.players.values()) {
    const socket = sockets.get(player.id);

    if (socket) {
      sendSocket(socket, payload);
    }
  }
}

function broadcastRoomState(room) {
  broadcastRoom(room, {
    type: "room_state",
    room: getRoomState(room)
  });
}

function createRoom(user) {
  const code = randomRoomCode();

  const player = makePlayer({
    ...user,
    name: sanitizeName(user.name)
  });

  const room = {
    code,
    createdBy: player.id,
    createdAt: now(),
    updatedAt: now(),
    status: "waiting",
    players: new Map()
  };

  room.players.set(player.id, player);
  rooms.set(code, room);

  return room;
}

function joinRoom(room, user) {
  const userId = String(user.id);

  const existing = room.players.get(userId);

  if (existing) {
    existing.name = sanitizeName(user.name);
    existing.username = user.username || existing.username || "";
    existing.lastSeen = now();

    return {
      ok: true,
      player: existing
    };
  }

  if (room.players.size >= 2) {
    return {
      ok: false,
      error: "ROOM_FULL"
    };
  }

  const player = makePlayer({
    ...user,
    name: sanitizeName(user.name)
  });

  room.players.set(userId, player);
  room.updatedAt = now();

  if (room.players.size === 2) {
    room.status = "ready";
  }

  return {
    ok: true,
    player
  };
}

function leaveRoom(userId, code) {
  const room = rooms.get(code);

  if (!room) {
    return;
  }

  const playerId = String(userId);

  room.players.delete(playerId);

  const socket = sockets.get(playerId);

  if (socket && socket.roomCode === code) {
    socket.roomCode = null;
  }

  if (room.players.size === 0) {
    rooms.delete(code);
    return;
  }

  room.status = "waiting";
  room.updatedAt = now();

  broadcastRoomState(room);
}

function cleanupRooms() {
  const current = now();

  for (const [code, room] of rooms) {
    if (current - room.updatedAt > ROOM_TTL) {
      for (const player of room.players.values()) {
        const socket = sockets.get(player.id);

        if (socket && socket.roomCode === code) {
          sendSocket(socket, {
            type: "room_expired"
          });

          socket.roomCode = null;
        }
      }

      rooms.delete(code);
      continue;
    }

    for (const player of room.players.values()) {
      if (
        player.connected &&
        current - player.lastSeen > PLAYER_TIMEOUT
      ) {
        player.connected = false;
      }
    }

    if (room.players.size === 2) {
      room.status = "ready";
    } else {
      room.status = "waiting";
    }
  }
}

setInterval(cleanupRooms, 15000);

app.get("/", (req, res) => {
  res.sendFile(__dirname + "/index.html");
});

app.get("/health", (req, res) => {
  json(res, 200, {
    ok: true,
    rooms: rooms.size,
    uptime: process.uptime()
  });
});

app.get("/api/room/:code", (req, res) => {
  const code = String(req.params.code);

  const room = rooms.get(code);

  if (!room) {
    return json(res, 404, {
      ok: false,
      error: "ROOM_NOT_FOUND"
    });
  }

  return json(res, 200, {
    ok: true,
    room: getRoomState(room)
  });
});

app.post("/api/room/create", (req, res) => {
  const initData = req.headers["x-telegram-init-data"];

  const telegramUser = getTelegramUserFromInitData(initData);

  if (!telegramUser) {
    return json(res, 401, {
      ok: false,
      error: "INVALID_TELEGRAM_DATA"
    });
  }

  const existingSocket = sockets.get(String(telegramUser.id));

  if (
    existingSocket &&
    existingSocket.roomCode &&
    rooms.has(existingSocket.roomCode)
  ) {
    const existingRoom = rooms.get(existingSocket.roomCode);

    return json(res, 200, {
      ok: true,
      existing: true,
      room: getRoomState(existingRoom)
    });
  }

  const room = createRoom({
    id: telegramUser.id,
    name: telegramUser.first_name || "Player",
    username: telegramUser.username || ""
  });

  return json(res, 200, {
    ok: true,
    room: getRoomState(room)
  });
});

app.post("/api/room/join", (req, res) => {
  const initData = req.headers["x-telegram-init-data"];
  const telegramUser = getTelegramUserFromInitData(initData);

  if (!telegramUser) {
    return json(res, 401, {
      ok: false,
      error: "INVALID_TELEGRAM_DATA"
    });
  }

  const code = String(req.body?.code || "").trim();

  if (!/^\d{6}$/.test(code)) {
    return json(res, 400, {
      ok: false,
      error: "INVALID_ROOM_CODE"
    });
  }

  const room = rooms.get(code);

  if (!room) {
    return json(res, 404, {
      ok: false,
      error: "ROOM_NOT_FOUND"
    });
  }

  const result = joinRoom(room, {
    id: telegramUser.id,
    name: telegramUser.first_name || "Player",
    username: telegramUser.username || ""
  });

  if (!result.ok) {
    return json(res, 409, {
      ok: false,
      error: result.error
    });
  }

  return json(res, 200, {
    ok: true,
    room: getRoomState(room)
  });
});

wss.on("connection", (socket, request) => {
  socket.userId = null;
  socket.roomCode = null;

  const url = new URL(request.url, `http://${request.headers.host}`);

  const initData = url.searchParams.get("initData");

  const telegramUser = getTelegramUserFromInitData(initData);

  if (!telegramUser) {
    sendSocket(socket, {
      type: "error",
      error: "INVALID_TELEGRAM_DATA"
    });

    socket.close();
    return;
  }

  const userId = String(telegramUser.id);

  socket.userId = userId;

  const oldSocket = sockets.get(userId);

  if (oldSocket && oldSocket !== socket) {
    try {
      oldSocket.close();
    } catch {}
  }

  sockets.set(userId, socket);

  sendSocket(socket, {
    type: "connected",
    user: {
      id: userId,
      name: telegramUser.first_name || "Player",
      username: telegramUser.username || ""
    }
  });

  socket.on("message", raw => {
    try {
      const message = JSON.parse(raw.toString());

      handleSocketMessage(socket, message, telegramUser);
    } catch {
      sendSocket(socket, {
        type: "error",
        error: "INVALID_MESSAGE"
      });
    }
  });

  socket.on("close", () => {
    if (sockets.get(userId) === socket) {
      sockets.delete(userId);
    }

    if (!socket.roomCode) {
      return;
    }

    const room = rooms.get(socket.roomCode);

    if (!room) {
      return;
    }

    const player = room.players.get(userId);

    if (player) {
      player.connected = false;
      player.lastSeen = now();
      room.updatedAt = now();
    }

    broadcastRoom(room, {
      type: "player_connection",
      userId,
      connected: false
    });

    broadcastRoomState(room);
  });
});

function handleSocketMessage(socket, message, telegramUser) {
  const userId = String(telegramUser.id);

  if (message.type === "ping") {
    const room = socket.roomCode
      ? rooms.get(socket.roomCode)
      : null;

    if (room) {
      const player = room.players.get(userId);

      if (player) {
        player.lastSeen = now();
        player.connected = true;
      }
    }

    sendSocket(socket, {
      type: "pong",
      time: now()
    });

    return;
  }

  if (message.type === "join_room") {
    const code = String(message.code || "").trim();

    if (!/^\d{6}$/.test(code)) {
      return sendSocket(socket, {
        type: "error",
        error: "INVALID_ROOM_CODE"
      });
    }

    const room = rooms.get(code);

    if (!room) {
      return sendSocket(socket, {
        type: "error",
        error: "ROOM_NOT_FOUND"
      });
    }

    const result = joinRoom(room, {
      id: telegramUser.id,
      name: telegramUser.first_name || "Player",
      username: telegramUser.username || ""
    });

    if (!result.ok) {
      return sendSocket(socket, {
        type: "error",
        error: result.error
      });
    }

    socket.roomCode = code;

    const player = room.players.get(userId);

    player.connected = true;
    player.lastSeen = now();

    room.updatedAt = now();

    broadcastRoomState(room);

    return;
  }

  if (message.type === "create_room") {
    if (socket.roomCode) {
      return sendSocket(socket, {
        type: "error",
        error: "ALREADY_IN_ROOM"
      });
    }

    const room = createRoom({
      id: telegramUser.id,
      name: telegramUser.first_name || "Player",
      username: telegramUser.username || ""
    });

    socket.roomCode = room.code;

    const player = room.players.get(userId);

    player.connected = true;
    player.lastSeen = now();

    sendSocket(socket, {
      type: "room_created",
      room: getRoomState(room)
    });

    broadcastRoomState(room);

    return;
  }

  if (message.type === "leave_room") {
    if (!socket.roomCode) {
      return;
    }

    const code = socket.roomCode;

    leaveRoom(userId, code);

    socket.roomCode = null;

    sendSocket(socket, {
      type: "left_room"
    });

    return;
  }

  if (message.type === "ready") {
    if (!socket.roomCode) {
      return sendSocket(socket, {
        type: "error",
        error: "NOT_IN_ROOM"
      });
    }

    const room = rooms.get(socket.roomCode);

    if (!room) {
      return sendSocket(socket, {
        type: "error",
        error: "ROOM_NOT_FOUND"
      });
    }

    const player = room.players.get(userId);

    if (!player) {
      return sendSocket(socket, {
        type: "error",
        error: "PLAYER_NOT_IN_ROOM"
      });
    }

    player.ready = Boolean(message.value);
    player.lastSeen = now();

    room.updatedAt = now();

    broadcastRoomState(room);

    return;
  }

  sendSocket(socket, {
    type: "error",
    error: "UNKNOWN_MESSAGE"
  });
}

async function telegramApi(method, body) {
  if (!BOT_TOKEN) {
    throw new Error("BOT_TOKEN is missing");
  }

  const response = await fetch(
    `https://api.telegram.org/bot${BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    }
  );

  const data = await response.json();

  if (!data.ok) {
    throw new Error(data.description || "Telegram API error");
  }

  return data;
}

app.post("/telegram/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const update = req.body;

    if (!update || !update.message) {
      return;
    }

    const message = update.message;

    if (!message.text) {
      return;
    }

    const text = message.text.trim();
const command = text.split(/\s+/)[0].toLowerCase();

if (command !== "/start") {
  return;
}

    const chatId = message.chat.id;
    const firstName = message.from?.first_name || "Player";

    const keyboard = {
      inline_keyboard: [
        [
          {
            text: "CREATE GAME",
            web_app: {
              url: MINI_APP_URL
            }
          }
        ]
      ]
    };

    const welcome =
      `Welcome, ${firstName}.\n\n` +
      `Tap Battle is a two-player real-time game.\n\n` +
      `How to play:\n` +
      `1. Open the game with CREATE GAME.\n` +
      `2. Create a room.\n` +
      `3. Send the six-digit room code to your opponent.\n` +
      `4. Your opponent opens the game and joins with that code.\n` +
      `5. When both players are connected, the match can begin.\n\n` +
      `Only two players can be inside a room at the same time.`;

    await telegramApi("sendMessage", {
      chat_id: chatId,
      text: welcome,
      reply_markup: keyboard
    });
  } catch (error) {
    console.error("Telegram webhook error:", error);
  }
});

app.get("/telegram/set-webhook", async (req, res) => {
  try {
    if (!process.env.PUBLIC_URL) {
      return json(res, 500, {
        ok: false,
        error: "PUBLIC_URL is missing"
      });
    }

    const webhookUrl =
      `${process.env.PUBLIC_URL}/telegram/webhook`;

    const result = await telegramApi("setWebhook", {
      url: webhookUrl
    });

    return json(res, 200, result);
  } catch (error) {
    return json(res, 500, {
      ok: false,
      error: error.message
    });
  }
});

server.listen(PORT, () => {
  console.log(`Tap Battle server running on port ${PORT}`);
});
