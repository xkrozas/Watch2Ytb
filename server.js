const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const ytSearch = require('yt-search');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  pingInterval: 10000,
  pingTimeout: 5000
});

app.use(express.static(path.join(__dirname, 'public')));

// Estado de cada sala
const rooms = {};

function getCurrentVideoTime(room) {
  if (!room.isPlaying) return room.currentTime;
  const elapsed = (Date.now() - (room.lastUpdated || Date.now())) / 1000;
  return room.currentTime + elapsed;
}

// Reloj maestro de sincronización (cada 4 segundos)
setInterval(() => {
  for (const roomId in rooms) {
    const room = rooms[roomId];
    if (room && room.isPlaying) {
      io.to(roomId).emit('heartbeat-sync', {
        currentTime: getCurrentVideoTime(room),
        isPlaying: room.isPlaying,
        videoId: room.videoId
      });
    }
  }
}, 4000);

io.on('connection', (socket) => {
  let currentRoom = null;
  let currentUserName = '';

  // Unirse a sala o crearla
  socket.on('join-room', ({ roomId, username }) => {
    currentRoom = roomId;
    currentUserName = username || `User-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;
    socket.join(roomId);

    if (!rooms[roomId]) {
      rooms[roomId] = {
        videoId: 'dQw4w9WgXcQ',
        videoTitle: 'WatchParty - Bienvenido',
        currentTime: 0,
        isPlaying: false,
        playlist: [],
        history: [],
        users: {},
        lastUpdated: Date.now(),
        lastTrackChange: 0
      };
    }

    rooms[roomId].users[socket.id] = { name: currentUserName };

    // Enviar estado de la sala al usuario que entra
    socket.emit('sync-init', {
      ...rooms[roomId],
      currentTime: getCurrentVideoTime(rooms[roomId]),
      assignedName: currentUserName
    });

    // Actualizar participantes
    io.to(roomId).emit('room-users-updated', Object.values(rooms[roomId].users));
  });

  // Cambiar nombre de usuario
  socket.on('change-username', (newName) => {
    if (currentRoom && rooms[currentRoom] && rooms[currentRoom].users[socket.id]) {
      rooms[currentRoom].users[socket.id].name = newName.trim() || 'Invitado';
      io.to(currentRoom).emit('room-users-updated', Object.values(rooms[currentRoom].users));
    }
  });

  // Chat en vivo
  socket.on('send-chat', (text) => {
    if (!currentRoom || !rooms[currentRoom] || !text.trim()) return;
    const msg = {
      user: rooms[currentRoom].users[socket.id]?.name || 'Anónimo',
      text: text.trim(),
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };
    io.to(currentRoom).emit('new-chat-message', msg);
  });

  // Buscador de vídeos rápido y a prueba de fallos
  socket.on('search-query', async (query) => {
    if (!query || !query.trim()) return;
    const cleanQ = query.trim();

    try {
      // 1. Detectar si es un enlace directo a un vídeo
      const videoIdMatch = cleanQ.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=))([\w-]{11})/);
      if (videoIdMatch) {
        const vId = videoIdMatch[1];
        const info = await ytSearch({ videoId: vId }).catch(() => null);
        return socket.emit('search-results', [{
          videoId: vId,
          title: info ? info.title : 'Vídeo de YouTube',
          thumbnail: info ? info.thumbnail : `https://img.youtube.com/vi/${vId}/hqdefault.jpg`,
          duration: info ? info.timestamp : '',
          author: info?.author ? info.author.name : ''
        }]);
      }

      // 2. Búsqueda por texto normal
      const res = await ytSearch(cleanQ);
      const results = (res.videos || []).slice(0, 20).map((v) => ({
        videoId: v.videoId,
        title: v.title,
        thumbnail: v.thumbnail,
        duration: v.timestamp || '',
        author: v.author ? v.author.name : ''
      }));

      socket.emit('search-results', results);
    } catch (err) {
      console.error('Error en búsqueda:', err);
      socket.emit('search-results', []);
    }
  });

  // Control de vídeo
  socket.on('change-video', (video) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];

    // Guardar el anterior en el historial
    if (room.videoId) {
      room.history.unshift({ videoId: room.videoId, title: room.videoTitle });
      if (room.history.length > 25) room.history.pop();
      io.to(currentRoom).emit('history-updated', room.history);
    }

    room.videoId = video.videoId;
    room.videoTitle = video.title || 'Vídeo';
    room.currentTime = 0;
    room.isPlaying = true;
    room.lastUpdated = Date.now();

    io.to(currentRoom).emit('video-changed', { videoId: room.videoId, title: room.videoTitle });
  });

  socket.on('add-to-playlist', (video) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    rooms[currentRoom].playlist.push(video);
    io.to(currentRoom).emit('playlist-updated', rooms[currentRoom].playlist);
  });

  socket.on('remove-from-playlist', (index) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    rooms[currentRoom].playlist.splice(index, 1);
    io.to(currentRoom).emit('playlist-updated', rooms[currentRoom].playlist);
  });

  socket.on('video-ended', () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    const now = Date.now();
    if (now - room.lastTrackChange < 3000) return;
    room.lastTrackChange = now;

    if (room.playlist.length > 0) {
      const next = room.playlist.shift();
      room.history.unshift({ videoId: room.videoId, title: room.videoTitle });
      room.videoId = next.videoId;
      room.videoTitle = next.title;
      room.currentTime = 0;
      room.isPlaying = true;
      room.lastUpdated = Date.now();

      io.to(currentRoom).emit('video-changed', { videoId: room.videoId, title: room.videoTitle });
      io.to(currentRoom).emit('playlist-updated', room.playlist);
      io.to(currentRoom).emit('history-updated', room.history);
    }
  });

  socket.on('play', (time) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    rooms[currentRoom].isPlaying = true;
    rooms[currentRoom].currentTime = time;
    rooms[currentRoom].lastUpdated = Date.now();
    socket.to(currentRoom).emit('play', time);
  });

  socket.on('pause', (time) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    rooms[currentRoom].isPlaying = false;
    rooms[currentRoom].currentTime = time;
    rooms[currentRoom].lastUpdated = Date.now();
    socket.to(currentRoom).emit('pause', time);
  });

  socket.on('seek', (time) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    rooms[currentRoom].currentTime = time;
    rooms[currentRoom].lastUpdated = Date.now();
    socket.to(currentRoom).emit('seek', time);
  });

  socket.on('disconnect', () => {
    if (currentRoom && rooms[currentRoom] && rooms[currentRoom].users) {
      delete rooms[currentRoom].users[socket.id];
      io.to(currentRoom).emit('room-users-updated', Object.values(rooms[currentRoom].users));
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor W2G Clone listo en puerto ${PORT}`);
});
