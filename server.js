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

// 🔑 CONTRASEÑA DE ADMINISTRADOR (Usa variables de entorno en producción)
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

app.use(express.static(path.join(__dirname, 'public')));

// Estado de cada sala
const rooms = {};

function getCurrentVideoTime(room) {
  if (!room.isPlaying) return room.currentTime;
  const elapsed = (Date.now() - (room.lastUpdated || Date.now())) / 1000;
  return room.currentTime + elapsed;
}

// Datos de salas formateados para el panel de administración
function getAdminRoomsData() {
  const list = [];
  for (const roomId in rooms) {
    const room = rooms[roomId];
    const users = Object.values(room.users || {});
    list.push({
      id: roomId,
      usersCount: users.length,
      users: users,
      videoId: room.videoId,
      videoTitle: room.videoTitle || 'Vídeo de YouTube',
      isPlaying: room.isPlaying,
      queueCount: (room.playlist || []).length,
      permissions: room.permissions || { controlPlayer: 'all', manageVideos: 'all', chat: 'all' }
    });
  }
  return list;
}

function notifyAdmins() {
  io.to('admin-channel').emit('admin-rooms-data', getAdminRoomsData());
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
    if (!roomId || typeof roomId !== 'string') return;
    currentRoom = roomId.trim();
    currentUserName = (username || '').trim().substring(0, 25) || `User-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;
    socket.join(currentRoom);

    let isHost = false;

    if (!rooms[currentRoom]) {
      const generatedHostToken = Math.random().toString(36).substring(2) + Date.now().toString(36);
      rooms[currentRoom] = {
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
          controlPlayer: 'all',
          manageVideos: 'all',
          chat: 'all'
        },
        lastUpdated: Date.now(),
        lastTrackChange: 0,
        cleanupTimer: null
      };
      isHost = true;
      socket.emit('set-host-token', generatedHostToken);
    } else {
      const room = rooms[currentRoom];
      // Si la sala tenía programado borrarse por estar vacía, cancelamos el borrado
      if (room.cleanupTimer) {
        clearTimeout(room.cleanupTimer);
        room.cleanupTimer = null;
      }

      if (hostToken && room.hostToken === hostToken) {
        room.hostSocketId = socket.id;
        isHost = true;
      } else if (!room.hostSocketId || !io.sockets.sockets.has(room.hostSocketId)) {
        room.hostSocketId = socket.id;
        isHost = true;
        socket.emit('set-host-token', room.hostToken);
      }
    }

    rooms[currentRoom].users[socket.id] = { 
      name: currentUserName,
      isHost: isHost 
    };

    // Excluimos datos sensibles (hostToken, hostSocketId, cleanupTimer) antes de enviar al cliente
    const { hostToken: secretToken, hostSocketId, cleanupTimer, ...safeRoomData } = rooms[currentRoom];

    socket.emit('sync-init', {
      ...safeRoomData,
      currentTime: getCurrentVideoTime(rooms[currentRoom]),
      assignedName: currentUserName,
      isHost: isHost,
      permissions: rooms[currentRoom].permissions
    });

    io.to(currentRoom).emit('room-users-updated', Object.values(rooms[currentRoom].users));
    notifyAdmins();
  });

  // Sincronización bajo demanda (cuando un usuario sin permisos intenta tocar el reproductor)
  socket.on('request-sync', () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    socket.emit('heartbeat-sync', {
      currentTime: getCurrentVideoTime(room),
      isPlaying: room.isPlaying,
      videoId: room.videoId
    });
  });

  // Cambiar permisos de la sala
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
      notifyAdmins();
    }
  });

  // Cambiar nombre de usuario
  socket.on('change-username', (newName) => {
    if (currentRoom && rooms[currentRoom] && rooms[currentRoom].users[socket.id]) {
      rooms[currentRoom].users[socket.id].name = (newName || '').trim().substring(0, 25) || 'Invitado';
      io.to(currentRoom).emit('room-users-updated', Object.values(rooms[currentRoom].users));
      notifyAdmins();
    }
  });

  // Chat con permisos
  socket.on('send-chat', (text) => {
    if (!currentRoom || !rooms[currentRoom] || typeof text !== 'string' || !text.trim()) return;
    const room = rooms[currentRoom];

    if (room.permissions.chat === 'host' && !room.users[socket.id]?.isHost) {
      return socket.emit('action-blocked', 'El chat está reservado solo para el anfitrión.');
    }

    const msg = {
      user: room.users[socket.id]?.name || 'Anónimo',
      isHost: room.users[socket.id]?.isHost || false,
      text: text.trim().substring(0, 500),
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };
    io.to(currentRoom).emit('new-chat-message', msg);
  });

  // Buscador de vídeos
  socket.on('search-query', async (query) => {
    if (!query || typeof query !== 'string' || !query.trim()) return;
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
    if (!currentRoom || !rooms[currentRoom] || !video || !video.videoId) return;
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
    notifyAdmins();
  });

  socket.on('add-to-playlist', (video) => {
    if (!currentRoom || !rooms[currentRoom] || !video || !video.videoId) return;
    const room = rooms[currentRoom];

    if (room.permissions.manageVideos === 'host' && !room.users[socket.id]?.isHost) {
      return socket.emit('action-blocked', 'Solo el anfitrión puede añadir vídeos a la lista.');
    }

    room.playlist.push(video);
    io.to(currentRoom).emit('playlist-updated', room.playlist);
    notifyAdmins();
  });

  socket.on('remove-from-playlist', (index) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];

    if (room.permissions.manageVideos === 'host' && !room.users[socket.id]?.isHost) {
      return socket.emit('action-blocked', 'Solo el anfitrión puede quitar vídeos de la lista.');
    }

    if (index >= 0 && index < room.playlist.length) {
      room.playlist.splice(index, 1);
      io.to(currentRoom).emit('playlist-updated', room.playlist);
      notifyAdmins();
    }
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
      if (room.history.length > 25) room.history.pop();

      room.videoId = next.videoId;
      room.videoTitle = next.title;
      room.currentTime = 0;
      room.isPlaying = true;
      room.lastUpdated = Date.now();

      io.to(currentRoom).emit('video-changed', { videoId: room.videoId, title: room.videoTitle });
      io.to(currentRoom).emit('playlist-updated', room.playlist);
      io.to(currentRoom).emit('history-updated', room.history);
      notifyAdmins();
    } else {
      // Si la cola está vacía, detenemos el estado de reproducción de la sala
      room.isPlaying = false;
      room.currentTime = getCurrentVideoTime(room);
      room.lastUpdated = Date.now();
      notifyAdmins();
    }
  });

  socket.on('play', (time) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];

    if (room.permissions.controlPlayer === 'host' && !room.users[socket.id]?.isHost) {
      return socket.emit('action-blocked', 'Solo el anfitrión puede reproducir el vídeo.');
    }

    room.isPlaying = true;
    room.currentTime = typeof time === 'number' ? time : getCurrentVideoTime(room);
    room.lastUpdated = Date.now();
    socket.to(currentRoom).emit('play', room.currentTime);
    notifyAdmins();
  });

  socket.on('pause', (time) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];

    if (room.permissions.controlPlayer === 'host' && !room.users[socket.id]?.isHost) {
      return socket.emit('action-blocked', 'Solo el anfitrión puede pausar el vídeo.');
    }

    room.isPlaying = false;
    room.currentTime = typeof time === 'number' ? time : getCurrentVideoTime(room);
    room.lastUpdated = Date.now();
    socket.to(currentRoom).emit('pause', room.currentTime);
    notifyAdmins();
  });

  socket.on('seek', (time) => {
    if (!currentRoom || !rooms[currentRoom] || typeof time !== 'number') return;
    const room = rooms[currentRoom];

    if (room.permissions.controlPlayer === 'host' && !room.users[socket.id]?.isHost) {
      return socket.emit('action-blocked', 'Solo el anfitrión puede adelantar el vídeo.');
    }

    room.currentTime = time;
    room.lastUpdated = Date.now();
    socket.to(currentRoom).emit('seek', time);
  });

  // --- CANALES DE ADMINISTRACIÓN ---
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
      if (rooms[roomId].cleanupTimer) clearTimeout(rooms[roomId].cleanupTimer);
      io.to(roomId).emit('room-deleted');
      io.socketsLeave(roomId);
      delete rooms[roomId];
      notifyAdmins();
    }
  });

  socket.on('disconnect', () => {
    if (currentRoom && rooms[currentRoom] && rooms[currentRoom].users) {
      const room = rooms[currentRoom];
      const wasHost = room.users[socket.id]?.isHost;
      delete room.users[socket.id];

      const remainingSockets = Object.keys(room.users);

      if (remainingSockets.length > 0) {
        if (wasHost) {
          const newHostSocket = remainingSockets[0];
          room.hostSocketId = newHostSocket;
          room.users[newHostSocket].isHost = true;
          io.to(newHostSocket).emit('assigned-as-host', room.hostToken);
        }
        io.to(currentRoom).emit('room-users-updated', Object.values(room.users));
      } else {
        // Si la sala se queda sin usuarios, programar su borrado en 5 minutos
        const roomToClean = currentRoom;
        room.cleanupTimer = setTimeout(() => {
          if (rooms[roomToClean] && Object.keys(rooms[roomToClean].users).length === 0) {
            delete rooms[roomToClean];
            notifyAdmins();
          }
        }, 5 * 60 * 1000);
      }

      notifyAdmins();
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor W2G Red Edition listo en puerto ${PORT}`);
});
