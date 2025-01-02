import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import cors from 'cors';
import 'dotenv/config';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
app.use(cors());

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: process.env.NODE_ENV === 'production' 
      ? ['https://effulgent-pasca-5bb177.netlify.app/']
      : ["http://localhost:5173"],
    methods: ["GET", "POST"]
  }
});

// Store active rooms and their data
const rooms = new Map();

// Generate a random 6-digit room ID
const generateRoomId = () => {
  let roomId;
  do {
    roomId = Math.floor(100000 + Math.random() * 900000).toString();
  } while (rooms.has(roomId));
  return roomId;
};

// Initialize game state for a room
const initializeGameState = (players) => ({
  currentPlayer: 0,
  players: players.map(p => ({
    id: p.id,
    username: p.username,
    eliminated: false,
    cells: Array(6).fill({ stage: 0, isActive: false, bullets: 0 })
  }))
});

// Process game actions
const processGameAction = (room, action, data) => {
  const { gameState } = room;
  const currentPlayer = gameState.players[gameState.currentPlayer];

  switch (action) {
    case 'roll': {
      const { value } = data;
      const cellIndex = value - 1;
      const cell = currentPlayer.cells[cellIndex];

      if (!cell.isActive) {
        // Activate new cell
        currentPlayer.cells[cellIndex] = {
          stage: 1,
          isActive: true,
          bullets: 0
        };
      } else if (cell.stage < 6) {
        // Progress cell
        cell.stage += 1;
        if (cell.stage === 6) {
          cell.bullets = 5;
        }
      } else if (cell.bullets === 0) {
        // Refill bullets
        cell.bullets = 5;
      }
      break;
    }

    case 'shoot': {
      const { targetPlayer, targetCell, sourceCell } = data;
      const shooterCell = currentPlayer.cells[sourceCell];
      const target = gameState.players[targetPlayer];

      if (shooterCell.bullets > 0) {
        // Reset target cell
        target.cells[targetCell] = {
          stage: 0,
          isActive: false,
          bullets: 0
        };

        // Decrease shooter's bullets
        shooterCell.bullets -= 1;

        // Check if target is eliminated
        target.eliminated = target.cells.every(cell => !cell.isActive);
      }
      break;
    }
  }

  // Move to next player
  do {
    gameState.currentPlayer = (gameState.currentPlayer + 1) % gameState.players.length;
  } while (
    gameState.players[gameState.currentPlayer].eliminated &&
    gameState.players.some(p => !p.eliminated)
  );

  return gameState;
};

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'healthy' });
});

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // Create a new room
  socket.on('createRoom', ({ maxPlayers, password, username }) => {
    const roomId = generateRoomId();
    const room = {
      id: roomId,
      leader: socket.id,
      password: password || null,
      maxPlayers,
      players: [{
        id: socket.id,
        username,
        ready: true,
        isLeader: true
      }],
      gameState: null,
      started: false
    };
    
    rooms.set(roomId, room);
    socket.join(roomId);
    
    socket.emit('roomCreated', {
      roomId,
      room: {
        ...room,
        password: undefined
      }
    });
  });

  // Join a room
  socket.on('joinRoom', ({ roomId, password, username }) => {
    const room = rooms.get(roomId);
    
    if (!room) {
      socket.emit('error', { message: 'Room not found' });
      return;
    }

    if (room.password && room.password !== password) {
      socket.emit('error', { message: 'Incorrect password' });
      return;
    }

    if (room.players.length >= room.maxPlayers) {
      socket.emit('error', { message: 'Room is full' });
      return;
    }

    if (room.started) {
      socket.emit('error', { message: 'Game already in progress' });
      return;
    }

    room.players.push({
      id: socket.id,
      username,
      ready: false,
      isLeader: false
    });

    socket.join(roomId);
    
    io.to(roomId).emit('playerJoined', {
      room: {
        ...room,
        password: undefined
      }
    });
  });

  // Player ready status change
  socket.on('toggleReady', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;

    const player = room.players.find(p => p.id === socket.id);
    if (player) {
      player.ready = !player.ready;
      io.to(roomId).emit('roomUpdated', {
        room: {
          ...room,
          password: undefined
        }
      });
    }
  });

  // Start game
  socket.on('startGame', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || room.leader !== socket.id) return;

    if (room.players.every(p => p.ready)) {
      room.started = true;
      room.gameState = initializeGameState(room.players);
      io.to(roomId).emit('gameStarted', { gameState: room.gameState });
    }
  });

  // Handle game actions
  socket.on('gameAction', ({ roomId, action, data }) => {
    const room = rooms.get(roomId);
    if (!room || !room.started) return;

    const currentPlayerId = room.players[room.gameState.currentPlayer].id;
    if (currentPlayerId !== socket.id) return;

    const updatedGameState = processGameAction(room, action, data);
    io.to(roomId).emit('gameStateUpdated', { gameState: updatedGameState });
  });

  // Handle disconnection
  socket.on('disconnect', () => {
    for (const [roomId, room] of rooms.entries()) {
      const playerIndex = room.players.findIndex(p => p.id === socket.id);
      
      if (playerIndex !== -1) {
        room.players.splice(playerIndex, 1);
        
        if (room.players.length === 0) {
          rooms.delete(roomId);
        } else if (room.leader === socket.id) {
          room.leader = room.players[0].id;
          room.players[0].isLeader = true;
        }

        io.to(roomId).emit('playerLeft', {
          room: {
            ...room,
            password: undefined
          }
        });
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
