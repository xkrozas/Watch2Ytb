const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const ytSearch = require('yt-search');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// 🔑 CONTRASEÑA DE ADMINISTRADOR (Cámbiala por la que tú quieras)
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

app.use(express.static(path.join(__dirname, 'public')));

// Almacén de salas
const rooms = {};

// Función auxiliar para obtener datos de todas las salas para el admin
function getAdminRoomsData() {
  const list = [];
  for (const roomId in rooms) {
    // Socket.io guarda cuántos sockets están unidos a cada sala
    const socketRoom = io.sockets.adapter.rooms.get(roomId);
    const userCount = socketRoom ? socketRoom.size : 0;

    list.push({
      id: roomId,
      users: userCount,
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

io.on('connection', (socket) => {
  let currentRoom = null;

  // --- GESTIÓN DE SALAS DE USUARIOS ---
  socket.on('join-room', (roomId) => {
    currentRoom = roomId;
    socket.join(roomId);

    if (!rooms[roomId]) {
      rooms[roomId] = {
        videoId: 'dQw4w9WgXcQ',
        currentTime: 0,
        isPlaying: false,
        playlist: [],
        lastTrackChange: 0
      };
    }

    socket.emit('sync-init', rooms[roomId]);
    // Notificar al panel admin que ha entrado alguien
    notifyAdmins();
  });

  // Buscador de YouTube
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
      io.to(currentRoom).emit('video-changed', nextVideo.videoId);
      io.to(currentRoom).emit('queue-updated', room.playlist);
      notifyAdmins();
    }
  });

  socket.on('play', (time) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    rooms[currentRoom].isPlaying = true;
    rooms[currentRoom].currentTime = time;
    socket.to(currentRoom).emit('play', time);
    notifyAdmins();
  });

  socket.on('pause', (time) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    rooms[currentRoom].isPlaying = false;
    rooms[currentRoom].currentTime = time;
    socket.to(currentRoom).emit('pause', time);
    notifyAdmins();
  });

  socket.on('seek', (time) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    rooms[currentRoom].currentTime = time;
    socket.to(currentRoom).emit('seek', time);
  });

  // --- GESTIÓN DEL PANEL DE ADMINISTRACIÓN ---

  // Login del administrador
  socket.on('admin-auth', (password) => {
    if (password === ADMIN_PASSWORD) {
      socket.join('admin-channel');
      socket.emit('admin-auth-success');
      socket.emit('admin-rooms-data', getAdminRoomsData());
    } else {
      socket.emit('admin-auth-fail');
    }
  });

  // Eliminar una sala
  socket.on('admin-delete-room', ({ password, roomId }) => {
    if (password !== ADMIN_PASSWORD) return;

    if (rooms[roomId]) {
      // 1. Avisar a todos los usuarios de esa sala para expulsarlos
      io.to(roomId).emit('room-deleted');
      // 2. Desconectar a todos de esa sala
      io.socketsLeave(roomId);
      // 3. Borrar la sala de la memoria
      delete rooms[roomId];
      // 4. Actualizar el panel de admin
      notifyAdmins();
    }
  });

  socket.on('disconnect', () => {
    // Al desconectarse alguien, actualizar los contadores del admin
    notifyAdmins();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor activo en puerto ${PORT}`);
});
