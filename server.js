const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;
const GAME = path.join(__dirname, 'index.html');
const rooms = new Map();

for (let i = 1; i <= 3; i++) {
  rooms.set('tutorial-' + i, {
    id: 'tutorial-' + i,
    clients: new Map(),
    locked: false,
    started: false,
    seq: 0
  });
}
for (let i = 1; i <= 3; i++) {
  rooms.set('cap1-' + i, {
    id: 'cap1-' + i,
    clients: new Map(),
    locked: false,
    started: false,
    seq: 0
  });
}

function roomSummary() {
  return [...rooms.values()].map(r => {
    let count = 0;
    for (const c of r.clients.values()) {
      if (c.ws && c.ws.readyState === WebSocket.OPEN) count++;
    }
    return {
      id: r.id,
      count,
      max: 3,
      locked: !!(r.locked || r.started)
    };
  });
}

function send(ws, msg) {
  if (ws.readyState === WebSocket.OPEN)
    ws.send(JSON.stringify(msg));
}

function broadcast(room, msg) {
  for (const c of room.clients.values())
    send(c.ws, msg);
}

function cleanName(v) {
  return String(v || 'Jogador')
    .replace(/[^\p{L}\p{N}_ -]/gu, '')
    .trim()
    .slice(0, 10) || 'Jogador';
}

function cleanChar(v) {
  return ['rui', 'lavvos', 'safira'].includes(v) ? v : 'rui';
}

function state(room) {
  const players = {};

  for (const [id, c] of room.clients) {
    players[id] = {
      name: c.name,
      charId: c.charId,
      x: c.x || 120,
      y: c.y || 0,
      vx: c.vx || 0,
      vy: c.vy || 0,
      facing: c.facing || 1,
      state: c.state || 'idle',
      joinOrder: c.joinOrder
    };
  }

  let leaderId = null;
  let best = Infinity;

  for (const [id, c] of room.clients) {
    if (c.joinOrder < best) {
      best = c.joinOrder;
      leaderId = id;
    }
  }

  return {
    room: room.id,
    players,
    leaderId,
    locked: room.locked || room.started,
    started: room.started
  };
}

function sendState(room) {
  broadcast(room, {
    type: 'room_state',
    ...state(room)
  });
}

function leaveRoom(client) {
  if (!client.room) return;

  const room = rooms.get(client.room);
  if (!room) return;

  room.clients.delete(client.id);
  client.room = null;

  if (room.clients.size === 0) {
    room.locked = false;
    room.started = false;
    room.seq = 0;
  } else if (!room.started) {
    room.locked = false;
  }

  broadcast(room, {
    type: 'left',
    id: client.id
  });

  sendState(room);
  broadcastRooms();
}

function broadcastRooms() {
  for (const ws of sockets)
    send(ws, {
      type: 'rooms',
      rooms: roomSummary()
    });
}

const sockets = new Set();

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');

  if (u.pathname === '/health') {
    res.writeHead(200, {
      'Content-Type': 'text/plain'
    });
    return res.end('OK');
  }

  if (
    u.pathname === '/' ||
    u.pathname === '/index.html' ||
    u.pathname === '/Stickman_Souls_Multiplayer.html' || u.pathname === '/index.html'
  ) {
    fs.readFile(GAME, (e, data) => {
      if (e) {
        res.writeHead(500);
        return res.end('Game file not found');
      }

      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8'
      });

      res.end(data);
    });

    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

const wss = new WebSocket.Server({
  server,
  path: '/ws'
});

wss.on('connection', (ws) => {
  const client = {
    ws,
    id: crypto.randomUUID(),
    name: 'Jogador',
    charId: 'rui',
    room: null,
    joinOrder: 0,
    x: 120,
    y: 0,
    vx: 0,
    vy: 0,
    facing: 1,
    state: 'idle',
    lastPing: Date.now()
  };

  sockets.add(ws);

  send(ws, {
    type: 'welcome',
    id: client.id,
    rooms: roomSummary()
  });

  ws.on('message', raw => {
    let m;

    try {
      m = JSON.parse(raw.toString());
    } catch {
      return;
    }
    client.lastPing = Date.now();

    if (m.type === 'hello') {
      client.name = cleanName(m.name);
      client.charId = cleanChar(m.charId);
      return;
    }

    if (m.type === 'ping') {
      client.lastPing = Date.now();
      send(ws, {
        type: 'pong'
      });
      return;
    }

    if (m.type === 'join_room') {
      if (client.room)
        leaveRoom(client);

      const room = rooms.get(String(m.room));

      if (
        !room ||
        room.clients.size >= 3 ||
        room.locked ||
        room.started
      ) {
        send(ws, {
          type: 'error',
          message: 'Esse servidor está cheio ou a partida já começou.'
        });
        return;
      }

      client.room = room.id;
      client.name = cleanName(m.name || client.name);
      client.charId = cleanChar(m.charId || client.charId);
      client.joinOrder = ++room.seq;

      room.clients.set(client.id, client);

      send(ws, {
        type: 'joined',
        room: room.id,
        selfChar: client.charId,
        ...state(room)
      });

      sendState(room);
      broadcastRooms();
      return;
    }

    if (m.type === 'set_char') {
      if (
        client.room &&
        !rooms.get(client.room).started
      ) {
        client.charId = cleanChar(m.charId);
      }

      if (client.room)
        sendState(rooms.get(client.room));

      return;
    }

    if (m.type === 'start_game') {
      const room = rooms.get(client.room);

      if (!room || room.started)
        return;

      let leaderId = null;
      let best = Infinity;

      for (const [id, c] of room.clients) {
        if (c.joinOrder < best) {
          best = c.joinOrder;
          leaderId = id;
        }
      }

      if (client.id !== leaderId) {
        send(ws, {
          type: 'error',
          message: 'Somente o líder pode apertar JOGAR.'
        });
        return;
      }

      room.locked = true;
      room.started = true;

      sendState(room);

      broadcast(room, {
        type: 'start',
        players: state(room).players,
        leaderId
      });

      broadcastRooms();
      return;
    }

    if (m.type === 'leave_room') {
      leaveRoom(client);
      return;
    }

    // Revive co-op: avisa o alvo sem derrubar a sala
    if (m.type === 'revive' && client.room) {
      const room = rooms.get(client.room);
      if (!room || !room.started) return;
      const targetId = String(m.targetId || '');
      if (!targetId || !room.clients.has(targetId)) return;
      broadcast(room, {
        type: 'revive',
        targetId,
        by: client.id
      });
      return;
    }

    if (
      m.type === 'player_state' &&
      client.room
    ) {
      const room = rooms.get(client.room);

      if (!room || !room.started)
        return;

      const p = m.player || {};

      client.x = Number.isFinite(p.x)
        ? Math.max(-10000, Math.min(100000, p.x))
        : client.x;

      client.y = Number.isFinite(p.y)
        ? Math.max(-2000, Math.min(2000, p.y))
        : client.y;

      client.vx = Number.isFinite(p.vx)
        ? p.vx
        : 0;

      client.vy = Number.isFinite(p.vy)
        ? p.vy
        : 0;

      client.facing = p.facing < 0 ? -1 : 1;
      client.state = String(p.state || 'idle').slice(0, 20);
      client.name = cleanName(p.name || client.name);
      client.downed = !!p.downed;
      client.downedTimer = Number.isFinite(p.downedTimer) ? p.downedTimer : 0;
      client.hp = Number.isFinite(p.hp) ? p.hp : client.hp;

      broadcast(room, {
        type: 'player_state',
        id: client.id,
        player: {
          x: client.x,
          y: client.y,
          vx: client.vx,
          vy: client.vy,
          facing: client.facing,
          charId: client.charId,
          name: client.name,
          state: client.state,
          downed: !!client.downed,
          downedTimer: client.downedTimer || 0,
          hp: client.hp
        }
      });

      return;
    }

    if (
      m.type === 'tutorial_complete' &&
      client.room
    ) {
      const room = rooms.get(client.room);

      if (!room)
        return;

      room.started = false;
      room.locked = false;

      for (const c of room.clients)
        c.room = null;

      room.clients.clear();

      broadcastRooms();
      return;
    }
  });

  ws.on('close', () => {
    leaveRoom(client);
    sockets.delete(ws);
  });

  ws.on('error', () => {
    try {
      ws.close();
    } catch {}
  });
});

// Remove jogadores fantasmas (sem ping ~45s) — evita sala "CHEIO" falsa
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    const dead = [];
    for (const [id, c] of room.clients) {
      if (!c.lastPing || now - c.lastPing > 45000) dead.push(c);
      else if (c.ws.readyState !== WebSocket.OPEN) dead.push(c);
    }
    for (const c of dead) {
      try { leaveRoom(c); } catch (e) {}
      try { c.ws.close(); } catch (e) {}
    }
  }
  for (const ws of [...sockets]) {
    if (ws.readyState !== WebSocket.OPEN) sockets.delete(ws);
  }
  broadcastRooms();
}, 10000);

server.listen(PORT, () => {
  console.log(
    `Stickman Souls multiplayer: http://localhost:${PORT}`
  );
});
