const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// Estado de cada sala en memoria: { videoId, currentTime, isPlaying, hostId }
const rooms = {};

io.on('connection', (socket) => {
  let currentRoom = null;

  socket.on('join-room', (roomId) => {
    currentRoom = roomId;
    socket.join(roomId);

    // Si la sala no existe, la inicializamos
    if (!rooms[roomId]) {
      rooms[roomId] = {
        videoId: 'dQw4w9WgXcQ', // Vídeo de prueba inicial
        currentTime: 0,
        isPlaying: false,
        lastUpdated: Date.now()
      };
    }

    // Enviar el estado actual de la sala al usuario que acaba de entrar
    socket.emit('sync-init', rooms[roomId]);

    // Avisar si entra un nuevo usuario
    socket.to(roomId).emit('user-joined');
  });

  // Cambiar de vídeo
  socket.on('change-video', (videoId) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    rooms[currentRoom].videoId = videoId;
    rooms[currentRoom].currentTime = 0;
    rooms[currentRoom].isPlaying = true;
    io.to(currentRoom).emit('video-changed', videoId);
  });

  // Reproducir
  socket.on('play', (time) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    rooms[currentRoom].isPlaying = true;
    rooms[currentRoom].currentTime = time;
    rooms[currentRoom].lastUpdated = Date.now();
    socket.to(currentRoom).emit('play', time);
  });

  // Pausar
  socket.on('pause', (time) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    rooms[currentRoom].isPlaying = false;
    rooms[currentRoom].currentTime = time;
    socket.to(currentRoom).emit('pause', time);
  });

  // Saltar a un segundo específico (Seek)
  socket.on('seek', (time) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    rooms[currentRoom].currentTime = time;
    socket.to(currentRoom).emit('seek', time);
  });

  socket.on('disconnect', () => {
    // Si la sala queda vacía, podrías limpiarla
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor activo en http://localhost:${PORT}`);
});