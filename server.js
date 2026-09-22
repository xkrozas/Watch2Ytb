const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const ytSearch = require('yt-search');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  pingInterval: 10000, // Comprobación de conexión más frecuente
  pingTimeout: 5000
});

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
app.use(express.static(path.join(__dirname, 'public')));

// Estado de salas
const rooms = {};

// Calcula el segundo exacto en el que debería estar el vídeo en este instante
function getCurrentVideoTime(room) {
  if (!room.isPlaying) return room.currentTime;
  const elapsed = (Date.now() - (room.lastUpdated || Date.now())) / 1000;
  return room.currentTime + elapsed;
}

function getAdminRoomsData() {
  const list = [];
  for (const roomId in rooms) {
    const socketRoom = io.sockets.adapter.rooms.get(roomId);
    list.push({
      id: roomId,
      users: socketRoom ? socketRoom.size : 0,
      videoId: rooms[roomId].videoId,
      isPlaying: rooms[roomId].isPlaying,
      queueCount: (rooms[roomId].playlist || []).length
    });
  }
  return list;
}

function notifyAdmins() {
  io.to('admin-channel').emit('admin-rooms-data', getAdminRoomsData());
}

// ⏱️ RELOJ MAESTRO: Emite el estado cada 4 segundos a todas las salas para corregir desfases
setInterval(() => {
  for (const roomId in rooms) {
    const room = rooms[roomId];
    if (room && room.isPlaying) {
      const liveTime = getCurrentVideoTime(room);
      io.to(roomId).emit('heartbeat-sync', {
        currentTime: liveTime,
        isPlaying: room.isPlaying,
        videoId: room.videoId
      });
    }
  }
}, 4000);

io.on('connection', (socket) => {
  let currentRoom = null;

  socket.on('join-room', (roomId) => {
    currentRoom = roomId;
    socket.join(roomId);

    if (!rooms[roomId]) {
      rooms[roomId] = {
        videoId: 'dQw4w9WgXcQ',
        currentTime: 0,
        isPlaying: false,
        playlist: [],
        lastUpdated: Date.now(),
        lastTrackChange: 0
      };
    }

    // Enviar el estado con el tiempo en vivo calculado
    const liveTime = getCurrentVideoTime(rooms[roomId]);
    socket.emit('sync-init', {
      ...rooms[roomId],
      currentTime: liveTime
    });

    // Actualizar recuento de personas en la sala
    const userCount = io.sockets.adapter.rooms.get(roomId)?.size || 1;
    io.to(roomId).emit('room-users-count', userCount);
    notifyAdmins();
  });

  // Petición manual de sincronización (botón 🔄 o al volver de otra pestaña)
  socket.on('request-sync', () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    socket.emit('heartbeat-sync', {
      currentTime: getCurrentVideoTime(room),
      isPlaying: room.isPlaying,
      videoId: room.videoId,
      force: true
    });
  });

  socket.on('search-videos', async (query) => {
    try {
      const searchResults = await ytSearch(query);
      const videos = (searchResults.videos || []).slice(0, 10).map((v) => ({
        videoId: v.videoId,
        title: v.title,
        thumbnail: v.thumbnail,
        duration: v.timestamp,
        author: v.author ? v.author.name : ''
      }));
      socket.emit('search-results', videos);
    } catch (err) {
      socket.emit('search-results', []);
    }
  });

  socket.on('change-video', (video) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const videoId = typeof video === 'string' ? video : video.videoId;
    rooms[currentRoom].videoId = videoId;
    rooms[currentRoom].currentTime = 0;
    rooms[currentRoom].isPlaying = true;
    rooms[currentRoom].lastUpdated = Date.now();
    io.to(currentRoom).emit('video-changed', videoId);
    notifyAdmins();
  });

  socket.on('add-to-queue', (video) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    rooms[currentRoom].playlist.push(video);
    io.to(currentRoom).emit('queue-updated', rooms[currentRoom].playlist);
    notifyAdmins();
  });

  socket.on('remove-from-queue', (index) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    rooms[currentRoom].playlist.splice(index, 1);
    io.to(currentRoom).emit('queue-updated', rooms[currentRoom].playlist);
    notifyAdmins();
  });

  socket.on('video-ended', () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    const now = Date.now();
    if (now - room.lastTrackChange < 3000) return;
    room.lastTrackChange = now;

    if (room.playlist.length > 0) {
      const nextVideo = room.playlist.shift();
      room.videoId = nextVideo.videoId;
      room.currentTime = 0;
      room.isPlaying = true;
      room.lastUpdated = Date.now();
      io.to(currentRoom).emit('video-changed', nextVideo.videoId);
      io.to(currentRoom).emit('queue-updated', room.playlist);
      notifyAdmins();
    }
  });

  socket.on('play', (time) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    rooms[currentRoom].isPlaying = true;
    rooms[currentRoom].currentTime = time;
    rooms[currentRoom].lastUpdated = Date.now();
    socket.to(currentRoom).emit('play', time);
    notifyAdmins();
  });

  socket.on('pause', (time) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    rooms[currentRoom].isPlaying = false;
    rooms[currentRoom].currentTime = time;
    rooms[currentRoom].lastUpdated = Date.now();
    socket.to(currentRoom).emit('pause', time);
    notifyAdmins();
  });

  socket.on('seek', (time) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    rooms[currentRoom].currentTime = time;
    rooms[currentRoom].lastUpdated = Date.now();
    socket.to(currentRoom).emit('seek', time);
  });

  // Panel de Admin
  socket.on('admin-auth', (password) => {
    if (password === ADMIN_PASSWORD) {
      socket.join('admin-channel');
      socket.emit('admin-auth-success');
      socket.emit('admin-rooms-data', getAdminRoomsData());
    } else {
      socket.emit('admin-auth-fail');
    }
  });

  socket.on('admin-delete-room', ({ password, roomId }) => {
    if (password !== ADMIN_PASSWORD) return;
    if (rooms[roomId]) {
      io.to(roomId).emit('room-deleted');
      io.socketsLeave(roomId);
      delete rooms[roomId];
      notifyAdmins();
    }
  });

  socket.on('disconnect', () => {
    if (currentRoom) {
      const count = io.sockets.adapter.rooms.get(currentRoom)?.size || 0;
      io.to(currentRoom).emit('room-users-count', count);
    }
    notifyAdmins();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor activo en puerto ${PORT}`);
});
