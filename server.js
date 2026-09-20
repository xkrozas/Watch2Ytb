const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const ytSearch = require('yt-search');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// Almacén de salas
const rooms = {};

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
        lastTrackChange: 0
      };
    }

    // Enviar estado inicial completo (vídeo actual + cola)
    socket.emit('sync-init', rooms[roomId]);
  });

  // Buscador de YouTube integrado
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
      console.error('Error buscando:', err);
      socket.emit('search-results', []);
    }
  });

  // Cambiar de vídeo inmediatamente
  socket.on('change-video', (video) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const videoId = typeof video === 'string' ? video : video.videoId;
    rooms[currentRoom].videoId = videoId;
    rooms[currentRoom].currentTime = 0;
    rooms[currentRoom].isPlaying = true;
    io.to(currentRoom).emit('video-changed', videoId);
  });

  // Añadir vídeo a la cola
  socket.on('add-to-queue', (video) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    rooms[currentRoom].playlist.push(video);
    io.to(currentRoom).emit('queue-updated', rooms[currentRoom].playlist);
  });

  // Eliminar vídeo de la cola
  socket.on('remove-from-queue', (index) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    rooms[currentRoom].playlist.splice(index, 1);
    io.to(currentRoom).emit('queue-updated', rooms[currentRoom].playlist);
  });

  // El vídeo ha terminado -> Pasar al siguiente en la cola automáticamente
  socket.on('video-ended', () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];

    // Evitar que si varios usuarios terminan a la vez se salten varios vídeos
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
    }
  });

  // Sincronización de controles
  socket.on('play', (time) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    rooms[currentRoom].isPlaying = true;
    rooms[currentRoom].currentTime = time;
    socket.to(currentRoom).emit('play', time);
  });

  socket.on('pause', (time) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    rooms[currentRoom].isPlaying = false;
    rooms[currentRoom].currentTime = time;
    socket.to(currentRoom).emit('pause', time);
  });

  socket.on('seek', (time) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    rooms[currentRoom].currentTime = time;
    socket.to(currentRoom).emit('seek', time);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor activo en puerto ${PORT}`);
});
