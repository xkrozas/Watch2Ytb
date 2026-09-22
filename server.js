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

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
app.use(express.static(path.join(__dirname, 'public')));

// Estado de cada sala
const rooms = {};

function getCurrentVideoTime(room) {
  if (!room.isPlaying) return room.currentTime;
  const elapsed = (Date.now() - (room.lastUpdated || Date.now())) / 1000;
  return room.currentTime + elapsed;
}

function getAdminRoomsData() {
  const list = [];
  for (const roomId in rooms) {
    const userNames = Object.values(rooms[roomId].users || {}).map((u) => u.name);
    list.push({
      id: roomId,
      users: userNames.length,
      userList: userNames,
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

// Reloj maestro de sincronización cada 4 segundos
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

// Extracción rápida de ID de YouTube si es enlace
function extractYouTubeId(str) {
  const match = str.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=))([\w-]{11})/);
  return match ? match[1] : null;
}

io.on('connection', (socket) => {
  let currentRoom = null;

  socket.on('join-room', ({ roomId, username }) => {
    currentRoom = roomId;
    socket.join(roomId);

    const isFirstUser = !rooms[roomId] || Object.keys(rooms[roomId].users || {}).length === 0;

    if (!rooms[roomId]) {
      rooms[roomId] = {
        videoId: 'dQw4w9WgXcQ',
        currentTime: 0,
        isPlaying: false,
        playlist: [],
        lastUpdated: Date.now(),
        lastTrackChange: 0,
        users: {}
      };
    }

    const cleanName = (username && username.trim()) ? username.trim() : `User-${socket.id.substring(0, 4).toUpperCase()}`;

    rooms[roomId].users[socket.id] = {
      name: cleanName,
      isHost: isFirstUser
    };

    // Estado inicial de la sala
    socket.emit('sync-init', {
      ...rooms[roomId],
      currentTime: getCurrentVideoTime(rooms[roomId]),
      isHost: isFirstUser
    });

    const activeUsers = Object.values(rooms[roomId].users);
    io.to(roomId).emit('room-users-list', activeUsers);
    notifyAdmins();
  });

  // --- BUSCADOR BLINDADO ULTRA-RÁPIDO ---
  socket.on('search-videos', async ({ query }) => {
    const q = (query || '').trim();
    if (!q) return socket.emit('search-results', []);

    // 1. Si pegan directamente una URL de YouTube
    const directId = extractYouTubeId(q);
    if (directId) {
      try {
        const vidInfo = await ytSearch({ videoId: directId });
        return socket.emit('search-results', [{
          videoId: directId,
          title: vidInfo.title || 'Vídeo de YouTube',
          thumbnail: vidInfo.thumbnail || `https://i.ytimg.com/vi/${directId}/hqdefault.jpg`,
          duration: vidInfo.timestamp || 'Vídeo',
          author: vidInfo.author ? vidInfo.author.name : 'YouTube'
        }]);
      } catch (e) {
        return socket.emit('search-results', [{
          videoId: directId,
          title: 'Vídeo de YouTube',
          thumbnail: `https://i.ytimg.com/vi/${directId}/hqdefault.jpg`,
          duration: 'Vídeo',
          author: 'YouTube'
        }]);
      }
    }

    // 2. Si es una lista de reproducción
    const listMatch = q.match(/[?&]list=([^#&?]+)/);
    if (listMatch) {
      try {
        const playlistData = await ytSearch({ listId: listMatch[1] });
        const videos = (playlistData.videos || []).slice(0, 30).map((v) => ({
          videoId: v.videoId,
          title: v.title,
          thumbnail: v.thumbnail,
          duration: typeof v.duration === 'string' ? v.duration : (v.duration?.timestamp || ''),
          author: playlistData.author ? playlistData.author.name : 'Playlist'
        }));
        return socket.emit('search-results', videos);
      } catch (e) {}
    }

    // 3. Búsqueda normal por palabras clave con límite estricto de 4 segundos
    try {
      const searchPromise = ytSearch(q);
      const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 4000));
      const searchResults = await Promise.race([searchPromise, timeoutPromise]);

      const videos = (searchResults.videos || []).slice(0, 20).map((v) => ({
        videoId: v.videoId,
        title: v.title,
        thumbnail: v.thumbnail,
        duration: v.timestamp || '',
        author: v.author ? v.author.name : 'YouTube'
      }));

      socket.emit('search-results', videos);
    } catch (err) {
      console.warn('Error o tiempo agotado en búsqueda:', err.message);
      socket.emit('search-results', []);
    }
  });

  // --- CHAT EN TIEMPO REAL ---
  socket.on('send-chat', (text) => {
    if (!currentRoom || !rooms[currentRoom] || !text.trim()) return;
    const user = rooms[currentRoom].users[socket.id] || { name: 'Invitado', isHost: false };
    const now = new Date();
    const timeStr = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;

    io.to(currentRoom).emit('new-chat-message', {
      user: user.name,
      isHost: user.isHost,
      text: text.trim().substring(0, 300),
      time: timeStr
    });
  });

  // Controles de vídeo
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

  // Admin
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
    if (currentRoom && rooms[currentRoom] && rooms[currentRoom].users) {
      delete rooms[currentRoom].users[socket.id];
      const activeUsers = Object.values(rooms[currentRoom].users);
      io.to(currentRoom).emit('room-users-list', activeUsers);
    }
    notifyAdmins();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor activo en puerto ${PORT}`);
});
