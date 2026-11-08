const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.json({ limit: '10mb' })); // Увеличенный лимит для PNG картинок
app.use(express.static(path.join(__dirname, 'public')));

const DB_FILE = path.join(__dirname, 'users.json');

let db = {
  users: {},
  reservedEmojis: ['👷', '🦈', '👨', '🔫', '🏹', '💀', '🟩', '🔴'],
  globalCharacters: [],
  globalMobs: []
};

function loadDB() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const data = fs.readFileSync(DB_FILE, 'utf8');
      const parsed = JSON.parse(data);
      db = { ...db, ...parsed };
    }
  } catch (e) {
    console.log('Ошибка чтения базы данных');
  }
}

function saveDB() {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
  } catch (e) {
    console.log('Ошибка записи базы данных');
  }
}

loadDB();

let globalPlayerCounter = 1;
const activeServers = {};
let serverAutoIndex = 1;

io.on('connection', (socket) => {
  const playerNum = String(globalPlayerCounter++).padStart(4, '0');
  socket.username = `Игрок ${playerNum}`;
  socket.userEmail = null;
  socket.currentRoom = null;

  socket.emit('init_data', {
    username: socket.username,
    reservedEmojis: db.reservedEmojis,
    globalCharacters: db.globalCharacters,
    globalMobs: db.globalMobs
  });

  socket.on('auth_login', (email) => {
    if (!email || !email.trim().toLowerCase().endsWith('@gmail.com')) {
      return socket.emit('auth_error', 'Ошибка! Введите настоящую почту с окончанием @gmail.com');
    }
    const cleanEmail = email.trim().toLowerCase();
    const defaultUname = cleanEmail.split('@')[0];

    if (!db.users[cleanEmail]) {
      db.users[cleanEmail] = { email: cleanEmail, username: defaultUname };
      saveDB();
    }

    socket.userEmail = cleanEmail;
    socket.username = db.users[cleanEmail].username;

    socket.emit('auth_success', { username: socket.username, email: cleanEmail });
  });

  socket.on('change_username', (newName) => {
    if (newName && newName.trim().length > 0) {
      socket.username = newName.trim().slice(0, 20);
      if (socket.userEmail && db.users[socket.userEmail]) {
        db.users[socket.userEmail].username = socket.username;
        saveDB();
      }
      socket.emit('username_updated', socket.username);
    }
  });

  // Создание глобального персонажа (с поддержкой PNG картинок)
  socket.on('create_character', (charData) => {
    if (charData.emoji && db.reservedEmojis.includes(charData.emoji)) {
      return socket.emit('char_error', 'Персонаж с таким эмодзи уже существует!');
    }
    if (charData.emoji) db.reservedEmojis.push(charData.emoji);
    
    charData.creator = socket.userEmail || socket.username;
    db.globalCharacters.push(charData);
    saveDB();

    io.emit('new_global_character', charData);
  });

  // Создание глобального моба
  socket.on('create_mob', (mobData) => {
    if (db.reservedEmojis.includes(mobData.emoji)) {
      return socket.emit('char_error', 'Моб с таким эмодзи уже существует!');
    }
    db.reservedEmojis.push(mobData.emoji);
    mobData.creator = socket.userEmail || socket.username;
    db.globalMobs.push(mobData);
    saveDB();

    io.emit('new_global_mob', mobData);
  });

  socket.on('get_servers', () => sendServerList(socket));

  socket.on('create_room', ({ name, maxPlayers }) => {
    if (Object.keys(activeServers).length >= 12) {
      return socket.emit('error_msg', 'Ошибка: Все 12 серверов уже созданы!');
    }
    const roomId = 'room_' + Date.now();
    const roomName = name.trim() || `server ${String(serverAutoIndex++).padStart(4, '0')}`;
    const limit = Math.min(Math.max(parseInt(maxPlayers) || 10, 2), 50);

    activeServers[roomId] = { id: roomId, name: roomName, maxPlayers: limit, players: {}, blocks: [], mobs: [] };
    joinRoom(socket, roomId);
  });

  socket.on('quick_search', () => {
    let foundRoomId = Object.keys(activeServers).find(id => {
      const room = activeServers[id];
      return Object.keys(room.players).length < room.maxPlayers;
    });

    if (!foundRoomId) {
      if (Object.keys(activeServers).length >= 12) {
        return socket.emit('error_msg', 'Все сервера сейчас заняты!');
      }
      foundRoomId = 'room_' + Date.now();
      const roomName = `server ${String(serverAutoIndex++).padStart(4, '0')}`;
      activeServers[foundRoomId] = { id: foundRoomId, name: roomName, maxPlayers: 50, players: {}, blocks: [], mobs: [] };
    }
    joinRoom(socket, foundRoomId);
  });

  socket.on('join_room', (roomId) => {
    if (activeServers[roomId]) joinRoom(socket, roomId);
    else socket.emit('error_msg', 'Сервер не найден');
  });

  socket.on('player_update', (data) => {
    const room = activeServers[socket.currentRoom];
    if (room && room.players[socket.id]) {
      Object.assign(room.players[socket.id], data);
      socket.to(socket.currentRoom).emit('player_moved', { id: socket.id, ...data });
    }
  });

  socket.on('spawn_mob', (mobTemplate) => {
    const room = activeServers[socket.currentRoom];
    if (room) {
      const player = room.players[socket.id];
      if (player) {
        const newMob = {
          id: 'mob_' + Math.random().toString(36).substring(2, 9),
          ...mobTemplate,
          x: player.x + (Math.random() - 0.5) * 2,
          y: player.y + (Math.random() - 0.5) * 2,
          maxHp: mobTemplate.hp || 500,
          targetPlayerId: null,
          isAggro: false,
          wanderTimer: 0,
          wanderDirX: 0,
          wanderDirY: 0
        };
        room.mobs.push(newMob);
        io.to(socket.currentRoom).emit('sync_mobs', room.mobs);
      }
    }
  });

  socket.on('deal_player_damage', ({ targetId, damage }) => {
    const room = activeServers[socket.currentRoom];
    if (room && room.players[targetId]) {
      const target = room.players[targetId];
      if (target.pvp) {
        target.hp = Math.max(0, target.hp - damage);
        if (target.hp <= 0) {
          target.hp = target.maxHp;
          target.x = 0;
          target.y = 0;
          io.to(socket.currentRoom).emit('player_respawned', { id: targetId, hp: target.hp, x: target.x, y: target.y });
        } else {
          io.to(socket.currentRoom).emit('player_hp_sync', { id: targetId, hp: target.hp });
        }
      }
    }
  });

  socket.on('spawn_block', (block) => {
    const room = activeServers[socket.currentRoom];
    if (room) {
      room.blocks.push(block);
      io.to(socket.currentRoom).emit('block_spawned', block);
    }
  });

  socket.on('block_damage', ({ blockIndex, damage }) => {
    const room = activeServers[socket.currentRoom];
    if (room && room.blocks[blockIndex]) {
      room.blocks[blockIndex].hp -= damage;
      if (room.blocks[blockIndex].hp <= 0) room.blocks.splice(blockIndex, 1);
      io.to(socket.currentRoom).emit('sync_blocks', room.blocks);
    }
  });

  socket.on('disconnect', () => leaveCurrentRoom(socket));
});

// ИИ мобов на сервере
setInterval(() => {
  for (const roomId in activeServers) {
    const room = activeServers[roomId];
    const playersArr = Object.values(room.players);
    if (playersArr.length === 0 || room.mobs.length === 0) continue;

    room.mobs.forEach(mob => {
      if (mob.mobBehavior === 'pacifist' || mob.mobBehavior === 'pacific') {
        mob.wanderTimer = (mob.wanderTimer || 0) + 0.1;
        if (mob.wanderTimer > 3) {
          mob.wanderTimer = 0;
          if (Math.random() < 0.5) {
            mob.wanderDirX = 0; mob.wanderDirY = 0;
          } else {
            const angle = Math.random() * Math.PI * 2;
            mob.wanderDirX = Math.cos(angle);
            mob.wanderDirY = Math.sin(angle);
          }
        }
        const spd = (mob.speed || 1.5) * 0.03;
        mob.x += mob.wanderDirX * spd;
        mob.y += mob.wanderDirY * spd;
      } else if (mob.mobBehavior === 'hostile') {
        let target = playersArr[0];
        let minDist = Infinity;
        playersArr.forEach(p => {
          const d = Math.hypot(p.x - mob.x, p.y - mob.y);
          if (d < minDist) { minDist = d; target = p; }
        });
        if (target) {
          const dx = target.x - mob.x;
          const dy = target.y - mob.y;
          const dist = Math.hypot(dx, dy);
          if (dist > 0.5) {
            const spd = (mob.speed || 1.5) * 0.04;
            mob.x += (dx / dist) * spd;
            mob.y += (dy / dist) * spd;
          }
        }
      }
    });

    io.to(roomId).emit('sync_mobs', room.mobs);
  }
}, 100);

function joinRoom(socket, roomId) {
  leaveCurrentRoom(socket);
  const room = activeServers[roomId];
  if (!room) return;
  if (Object.keys(room.players).length >= room.maxPlayers) return socket.emit('error_msg', 'Сервер полон!');

  socket.join(roomId);
  socket.currentRoom = roomId;
  room.players[socket.id] = {
    id: socket.id,
    username: socket.username,
    x: 0,
    y: 0,
    hp: 1000,
    maxHp: 1000,
    pvp: true,
    char: null
  };

  socket.emit('joined_room_success', { roomId: room.id, roomName: room.name, blocks: room.blocks, players: room.players, mobs: room.mobs });
  socket.to(roomId).emit('player_joined', room.players[socket.id]);
  io.emit('server_list_updated');
}

function leaveCurrentRoom(socket) {
  if (socket.currentRoom && activeServers[socket.currentRoom]) {
    const room = activeServers[socket.currentRoom];
    delete room.players[socket.id];
    socket.to(socket.currentRoom).emit('player_left', socket.id);
    if (Object.keys(room.players).length === 0) delete activeServers[socket.currentRoom];
    socket.leave(socket.currentRoom);
    socket.currentRoom = null;
    io.emit('server_list_updated');
  }
}

function sendServerList(socket) {
  const list = Object.values(activeServers).map(r => ({
    id: r.id, name: r.name, currentPlayers: Object.keys(r.players).length, maxPlayers: r.maxPlayers
  })).slice(0, 12);
  socket.emit('server_list', list);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Сервер запущен на порту ${PORT}`));