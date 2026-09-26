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

// Reloj maestro de sincronización (cada 4 segs)
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

  // Unirse a sala con comprobación de Anfitrión
  socket.on('join-room', ({ roomId, username, hostToken }) => {
    currentRoom = roomId;
    currentUserName = username || `User-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;
    socket.join(roomId);

    let isHost = false;

    // Si la sala es nueva, el creador es el Anfitrión
    if (!rooms[roomId]) {
      const generatedHostToken = Math.random().toString(36).substring(2) + Date.now().toString(36);
      rooms[roomId] = {
        videoId: 'dQw4w9WgXcQ',
        videoTitle: 'WatchParty - Bienvenido',
        currentTime: 0,
        isPlaying: false,
        playlist: [],
        history: [],
        users: {},
        hostToken: generatedHostToken,
        hostSocketId: socket.id,
        permissions: {
          controlPlayer: 'all', // 'all' | 'host'
          manageVideos: 'all',  // 'all' | 'host'
          chat: 'all'           // 'all' | 'host'
        },
        lastUpdated: Date.now(),
        lastTrackChange: 0
      };
      isHost = true;
      socket.emit('set-host-token', generatedHostToken);
    } else {
      const room = rooms[roomId];
      // Reconocer al anfitrión aunque refresque la página mediante su token
      if (hostToken && room.hostToken === hostToken) {
        room.hostSocketId = socket.id;
        isHost = true;
      } else if (!room.hostSocketId || !io.sockets.sockets.has(room.hostSocketId)) {
        // Si el anfitrión anterior se fue, se asigna al nuevo participante
        room.hostSocketId = socket.id;
        isHost = true;
        socket.emit('set-host-token', room.hostToken);
      }
    }

    rooms[roomId].users[socket.id] = { 
      name: currentUserName,
      isHost: isHost 
    };

    // Enviar estado completo con permisos actuales
    socket.emit('sync-init', {
      ...rooms[roomId],
      currentTime: getCurrentVideoTime(rooms[roomId]),
      assignedName: currentUserName,
      isHost: isHost,
      permissions: rooms[roomId].permissions
    });

    io.to(roomId).emit('room-users-updated', Object.values(rooms[roomId].users));
  });

  // Cambiar permisos de la sala (Solo el anfitrión puede hacerlo)
  socket.on('update-permissions', (newPermissions) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];

    if (room.users[socket.id]?.isHost) {
      room.permissions = {
        controlPlayer: newPermissions.controlPlayer === 'host' ? 'host' : 'all',
        manageVideos: newPermissions.manageVideos === 'host' ? 'host' : 'all',
        chat: newPermissions.chat === 'host' ? 'host' : 'all'
      };
      io.to(currentRoom).emit('permissions-updated', room.permissions);
    }
  });

  // Cambiar nombre de usuario
  socket.on('change-username', (newName) => {
    if (currentRoom && rooms[currentRoom] && rooms[currentRoom].users[socket.id]) {
      rooms[currentRoom].users[socket.id].name = newName.trim() || 'Invitado';
      io.to(currentRoom).emit('room-users-updated', Object.values(rooms[currentRoom].users));
    }
  });

  // Chat con control de permisos
  socket.on('send-chat', (text) => {
    if (!currentRoom || !rooms[currentRoom] || !text.trim()) return;
    const room = rooms[currentRoom];

    if (room.permissions.chat === 'host' && !room.users[socket.id]?.isHost) {
      return socket.emit('action-blocked', 'El chat está reservado solo para el anfitrión.');
    }

    const msg = {
      user: room.users[socket.id]?.name || 'Anónimo',
      isHost: room.users[socket.id]?.isHost || false,
      text: text.trim(),
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };
    io.to(currentRoom).emit('new-chat-message', msg);
  });

  // Buscador de vídeos
  socket.on('search-query', async (query) => {
    if (!query || !query.trim()) return;
    const cleanQ = query.trim();

    try {
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
      socket.emit('search-results', []);
    }
  });

  // Control de vídeo con permisos
  socket.on('change-video', (video) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];

    if (room.permissions.manageVideos === 'host' && !room.users[socket.id]?.isHost) {
      return socket.emit('action-blocked', 'Solo el anfitrión tiene permiso para cambiar vídeos.');
    }

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
    const room = rooms[currentRoom];

    if (room.permissions.manageVideos === 'host' && !room.users[socket.id]?.isHost) {
      return socket.emit('action-blocked', 'Solo el anfitrión puede añadir vídeos a la lista.');
    }

    room.playlist.push(video);
    io.to(currentRoom).emit('playlist-updated', room.playlist);
  });

  socket.on('remove-from-playlist', (index) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];

    if (room.permissions.manageVideos === 'host' && !room.users[socket.id]?.isHost) {
      return socket.emit('action-blocked', 'Solo el anfitrión puede quitar vídeos de la lista.');
    }

    room.playlist.splice(index, 1);
    io.to(currentRoom).emit('playlist-updated', room.playlist);
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
    const room = rooms[currentRoom];

    if (room.permissions.controlPlayer === 'host' && !room.users[socket.id]?.isHost) {
      return socket.emit('action-blocked', 'Solo el anfitrión puede reproducir el vídeo.');
    }

    room.isPlaying = true;
    room.currentTime = time;
    room.lastUpdated = Date.now();
    socket.to(currentRoom).emit('play', time);
  });

  socket.on('pause', (time) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];

    if (room.permissions.controlPlayer === 'host' && !room.users[socket.id]?.isHost) {
      return socket.emit('action-blocked', 'Solo el anfitrión puede pausar el vídeo.');
    }

    room.isPlaying = false;
    room.currentTime = time;
    room.lastUpdated = Date.now();
    socket.to(currentRoom).emit('pause', time);
  });

  socket.on('seek', (time) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];

    if (room.permissions.controlPlayer === 'host' && !room.users[socket.id]?.isHost) {
      return socket.emit('action-blocked', 'Solo el anfitrión puede adelantar el vídeo.');
    }

    room.currentTime = time;
    room.lastUpdated = Date.now();
    socket.to(currentRoom).emit('seek', time);
  });

  socket.on('disconnect', () => {
    if (currentRoom && rooms[currentRoom] && rooms[currentRoom].users) {
      const wasHost = rooms[currentRoom].users[socket.id]?.isHost;
      delete rooms[currentRoom].users[socket.id];

      // Si el anfitrión sale, transferir el rol al primer usuario disponible
      if (wasHost) {
        const remainingSockets = Object.keys(rooms[currentRoom].users);
        if (remainingSockets.length > 0) {
          const newHostSocket = remainingSockets[0];
          rooms[currentRoom].hostSocketId = newHostSocket;
          rooms[currentRoom].users[newHostSocket].isHost = true;
          io.to(newHostSocket).emit('assigned-as-host', rooms[currentRoom].hostToken);
        }
      }

      io.to(currentRoom).emit('room-users-updated', Object.values(rooms[currentRoom].users));
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor W2G Red Edition listo en puerto ${PORT}`);
});
