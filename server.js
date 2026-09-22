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

// --- FUNCIÓN MAESTRA: Obtener los vídeos 100% oficiales de un canal ---
async function fetchOfficialChannelVideos(channelName, channelUrl) {
  let channelId = null;

  try {
    // 1. Si la URL ya incluye directamente el ID de canal 'UC...'
    if (channelUrl) {
      const directMatch = channelUrl.match(/UC[\w-]{22}/);
      if (directMatch) channelId = directMatch[0];
    }

    // 2. Si no lo tiene, consultamos la página web del canal para extraer el channelId
    if (!channelId) {
      let targetUrl = channelUrl;
      if (!targetUrl || !targetUrl.startsWith('http')) {
        if (targetUrl && targetUrl.startsWith('/')) {
          targetUrl = 'https://www.youtube.com' + targetUrl;
        } else if (channelName.startsWith('@')) {
          targetUrl = `https://www.youtube.com/${channelName}`;
        } else {
          const search = await ytSearch(channelName);
          const firstChan = (search.channels || [])[0];
          if (firstChan && firstChan.url) {
            targetUrl = firstChan.url.startsWith('http') ? firstChan.url : 'https://www.youtube.com' + firstChan.url;
          } else {
            targetUrl = `https://www.youtube.com/@${channelName.replace(/\s+/g, '')}`;
          }
        }
      }

      if (targetUrl) {
        const res = await fetch(targetUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8'
          }
        });
        const html = await res.text();
        const match = html.match(/"channelId":"(UC[\w-]{22})"/);
        if (match) channelId = match[1];
        else {
          const matchMeta = html.match(/<meta itemprop="channelId" content="(UC[\w-]{22})">/);
          if (matchMeta) channelId = matchMeta[1];
        }
      }
    }

    // 3. Convertimos 'UC...' a 'UU...' (la lista oficial de subidas del canal de YouTube)
    if (channelId && channelId.startsWith('UC')) {
      const uploadsPlaylistId = 'UU' + channelId.slice(2);
      const playlistData = await ytSearch({ listId: uploadsPlaylistId });

      if (playlistData && playlistData.videos && playlistData.videos.length > 0) {
        return playlistData.videos.map((v) => ({
          videoId: v.videoId,
          title: v.title,
          thumbnail: v.thumbnail,
          duration: typeof v.duration === 'string' ? v.duration : (v.duration?.timestamp || ''),
          author: playlistData.author?.name || channelName,
          views: v.views ? Number(v.views).toLocaleString() : '',
          ago: ''
        }));
      }
    }
  } catch (err) {
    console.warn('Fallo al obtener la lista UU del canal, recurriendo a búsqueda estricta:', err.message);
  }

  // 4. Modo de respaldo: búsqueda estricta donde solo se aceptan coincidencias exactas del autor
  try {
    const searchRes = await ytSearch(`"${channelName}"`);
    const cleanTarget = channelName.toLowerCase().replace(/[^a-z0-9]/g, '');
    const strictlyFiltered = (searchRes.videos || []).filter((v) => {
      const cleanAuthor = (v.author?.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      return cleanAuthor.includes(cleanTarget) || cleanTarget.includes(cleanAuthor);
    });

    return strictlyFiltered.map((v) => ({
      videoId: v.videoId,
      title: v.title,
      thumbnail: v.thumbnail,
      duration: v.timestamp || '',
      author: v.author?.name || channelName,
      views: v.views ? Number(v.views).toLocaleString() : '',
      ago: v.ago || ''
    }));
  } catch (e) {
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

  // --- BÚSQUEDA GENERAL ---
  socket.on('search-videos', async ({ query, page = 1 }) => {
    try {
      // Detección de enlace de Playlist
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

      // Variación de consulta para páginas posteriores (Scroll infinito)
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

  // --- OBTENER VÍDEOS DE CANAL OFICIAL ---
  socket.on('get-channel-videos', async ({ channelName, channelUrl }) => {
    try {
      const videos = await fetchOfficialChannelVideos(channelName, channelUrl);
      socket.emit('channel-videos-result', {
        channelName,
        videos
      });
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
