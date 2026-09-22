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

// Estado de salas
const rooms = {};

function getCurrentVideoTime(room) {
  if (!room.isPlaying) return room.currentTime;
  const elapsed = (Date.now() - (room.lastUpdated || Date.now())) / 1000;
  return room.currentTime + elapsed;
}

function getAdminRoomsData() {
  const list = [];
  for (const roomId in rooms) {
    const userNames = Object.values(rooms[roomId].users || {});
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

// Reloj maestro de sincronización (cada 4 segs)
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

// --- BÚSQUEDA RÁPIDA Y LIMPIA DE VÍDEOS DEL CANAL (Sin bloqueos de Render) ---
async function fetchChannelVideosFast(channelName, channelUrl) {
  try {
    // 1. Si la URL ya incluye directamente el ID oficial 'UC...'
    if (channelUrl) {
      const match = channelUrl.match(/UC[\w-]{22}/);
      if (match) {
        const uploadsId = 'UU' + match[0].slice(2);
        try {
          const playlist = await ytSearch({ listId: uploadsId });
          if (playlist && playlist.videos && playlist.videos.length > 0) {
            return playlist.videos.map((v) => ({
              videoId: v.videoId,
              title: v.title,
              thumbnail: v.thumbnail,
              duration: typeof v.duration === 'string' ? v.duration : (v.duration?.timestamp || ''),
              author: playlist.author?.name || channelName,
              views: v.views ? Number(v.views).toLocaleString() : '',
              ago: ''
            }));
          }
        } catch (e) {
          // Si la lista directa falla, pasa al método nativo
        }
      }
    }

    // 2. Consulta rápida directa con ytSearch
    const searchRes = await ytSearch(channelName);
    const videos = searchRes.videos || [];

    const cleanTarget = channelName.toLowerCase().replace(/[^a-z0-9]/g, '');
    const forbiddenClipWords = ['clips', 'momentos', 'twitch', 'reacciones', 'fans', 'cortos', 'shorts'];

    // Filtramos para quedarnos con el creador y descartar canales de clips
    const officialVideos = videos.filter((v) => {
      const author = (v.author?.name || '').toLowerCase();
      const cleanAuthor = author.replace(/[^a-z0-9]/g, '');

      const matchesCreator = cleanAuthor.includes(cleanTarget) || cleanTarget.includes(cleanAuthor);
      const isClipChannel = forbiddenClipWords.some((w) => author.includes(w) && !cleanTarget.includes(w));

      return matchesCreator && !isClipChannel;
    });

    const listToReturn = officialVideos.length >= 3 ? officialVideos : videos;

    return listToReturn.map((v) => ({
      videoId: v.videoId,
      title: v.title,
      thumbnail: v.thumbnail,
      duration: v.timestamp || '',
      author: v.author?.name || channelName,
      views: v.views ? Number(v.views).toLocaleString() : '',
      ago: v.ago || ''
    }));
  } catch (err) {
    console.error('Error obteniendo vídeos del canal:', err);
    return [];
  }
}

io.on('connection', (socket) => {
  let currentRoom = null;
  let currentUserName = 'Anónimo';

  socket.on('join-room', ({ roomId, username }) => {
    currentRoom = roomId;
    currentUserName = (username && username.trim()) ? username.trim() : 'Invitado';
    socket.join(roomId);

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

    rooms[roomId].users[socket.id] = currentUserName;

    socket.emit('sync-init', {
      ...rooms[roomId],
      currentTime: getCurrentVideoTime(rooms[roomId])
    });

    const activeUsers = Object.values(rooms[roomId].users);
    io.to(roomId).emit('room-users-list', activeUsers);
    notifyAdmins();
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

  // Búsqueda general
  socket.on('search-videos', async (data) => {
    const query = (typeof data === 'string' ? data : (data?.query || '')).trim();
    const page = typeof data === 'object' && data?.page ? data.page : 1;

    if (!query) {
      return socket.emit('search-results', { isPlaylist: false, videos: [], channels: [], page, hasMore: false });
    }

    try {
      const listMatch = query.match(/[?&]list=([^#&?]+)/);
      if (listMatch) {
        const listId = listMatch[1];
        const playlistData = await ytSearch({ listId });
        const videos = (playlistData.videos || []).map((v) => ({
          videoId: v.videoId,
          title: v.title,
          thumbnail: v.thumbnail,
          duration: typeof v.duration === 'string' ? v.duration : (v.duration?.timestamp || ''),
          author: playlistData.author ? playlistData.author.name : (playlistData.title || '')
        }));
        return socket.emit('search-results', {
          isPlaylist: true,
          playlistTitle: playlistData.title || 'Lista de reproducción',
          videos,
          channels: [],
          page: 1,
          hasMore: false
        });
      }

      let searchQuery = query;
      if (page === 2) searchQuery = `${query} video`;
      else if (page === 3) searchQuery = `${query} videos`;
      else if (page > 3) searchQuery = `${query} playlist`;

      const searchResults = await ytSearch(searchQuery);

      const videos = (searchResults.videos || []).map((v) => ({
        videoId: v.videoId,
        title: v.title,
        thumbnail: v.thumbnail,
        duration: v.timestamp || '',
        author: v.author ? v.author.name : '',
        authorUrl: v.author ? (v.author.url || '') : '',
        views: v.views ? Number(v.views).toLocaleString() : '',
        ago: v.ago || ''
      }));

      const channels = (page === 1 ? (searchResults.channels || searchResults.accounts || []) : []).slice(0, 3).map((c) => ({
        name: c.name,
        url: c.url || '',
        avatar: c.image || c.avatar || '',
        subCount: c.subCountLabel || c.subscribers || '',
        videoCount: c.videoCount || ''
      }));

      socket.emit('search-results', {
        isPlaylist: false,
        videos,
        channels,
        page,
        hasMore: videos.length >= 10
      });
    } catch (err) {
      console.error('Error buscando:', err);
      socket.emit('search-results', { isPlaylist: false, videos: [], channels: [], page, hasMore: false });
    }
  });

  // Exploración de canal instantánea
  socket.on('get-channel-videos', async (data) => {
    const channelName = typeof data === 'string' ? data : (data?.channelName || '');
    const channelUrl = typeof data === 'object' ? (data?.channelUrl || '') : '';

    if (!channelName) {
      return socket.emit('channel-videos-result', { channelName: '', videos: [] });
    }

    try {
      const videos = await fetchChannelVideosFast(channelName, channelUrl);
      socket.emit('channel-videos-result', { channelName, videos });
    } catch (err) {
      console.error('Error cargando canal:', err);
      socket.emit('channel-videos-result', { channelName, videos: [] });
    }
  });

  // Controles de sala
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

  socket.on('add-multiple-to-queue', (videoList) => {
    if (!currentRoom || !rooms[currentRoom] || !Array.isArray(videoList)) return;
    rooms[currentRoom].playlist.push(...videoList);
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
