const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: true, // Dynamically allow the requesting origin
        methods: ["GET", "POST"],
        credentials: true,
        allowedHeaders: ["*"]
    }
});

// In-memory storage
const rooms = new Map();

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('create_room', ({ hostName, boardSize = 5 }, callback) => {
        const roomId = uuidv4().slice(0, 4).toUpperCase();
        const room = {
            id: roomId,
            host: hostName,
            boardSize: parseInt(boardSize),
            players: [],
            status: 'WAITING',
            drawnNumbers: [],
            winner: null,
            lastUpdated: Date.now(),
            currentTurnIndex: 0,
            messages: []
        };
        rooms.set(roomId, room);
        callback({ success: true, roomId });
    });

    socket.on('join_room', ({ roomId, playerName }, callback) => {
        const room = rooms.get(roomId);
        if (!room) {
            return callback({ error: 'Room not found' });
        }

        // Check if player exists or create new
        // For simplicity, we create a new player (id can be passed from client if reconnecting, but let's assume new session)
        const playerId = uuidv4();
        const newPlayer = { id: playerId, name: playerName, socketId: socket.id, board: [] };

        room.players.push(newPlayer);
        socket.join(roomId);

        // Notify everyone in room
        io.to(roomId).emit('room_updated', room);

        callback({ success: true, player: newPlayer, room });
    });

    socket.on('rejoin_room', ({ roomId, playerId }, callback) => {
        const room = rooms.get(roomId);
        if (!room) return callback({ error: 'Room not found' });

        const player = room.players.find(p => p.id === playerId);
        if (!player) return callback({ error: 'Player not found' });

        // Update socket ref
        player.socketId = socket.id;
        socket.join(roomId);

        callback({ success: true, room, player });
    });

    socket.on('start_game', ({ roomId }) => {
        const room = rooms.get(roomId);
        if (room) {
            room.status = 'PLAYING';
            room.currentTurnIndex = Math.floor(Math.random() * room.players.length);
            io.to(roomId).emit('room_updated', room);
        }
    });

    // Replaces random draw with manual submission
    socket.on('submit_number', ({ roomId, playerId, number }) => {
        const room = rooms.get(roomId);
        if (room && room.status === 'PLAYING') {
            const playerIndex = room.players.findIndex(p => p.id === playerId);

            // Validation: Is it this player's turn?
            if (playerIndex !== room.currentTurnIndex) return;

            // Validation: Number range
            const num = parseInt(number);
            if (isNaN(num) || num < 1 || num > 75) return;

            // Validation: Already drawn?
            if (room.drawnNumbers.includes(num)) return;

            room.drawnNumbers.push(num);

            // Advance turn (round robin)
            room.currentTurnIndex = (room.currentTurnIndex + 1) % room.players.length;

            io.to(roomId).emit('room_updated', room);
            io.to(roomId).emit('number_drawn', num);
        }
    });

    socket.on('send_message', ({ roomId, playerId, text }) => {
        const room = rooms.get(roomId);
        if (room) {
            const player = room.players.find(p => p.id === playerId);
            if (player) {
                const msg = {
                    id: uuidv4(),
                    sender: player.name,
                    text: text,
                    time: new Date().toLocaleTimeString()
                };
                room.messages.push(msg);
                // Keep chat history limited? Maybe last 50
                if (room.messages.length > 50) room.messages.shift();

                io.to(roomId).emit('room_updated', room);
            }
        }
    });

    socket.on('update_board', ({ roomId, playerId, board }) => {
        const room = rooms.get(roomId);
        if (room) {
            const player = room.players.find(p => p.id === playerId);
            if (player) {
                player.board = board;
                // Optionally invoke win check here if server was authoritative,
                // but strict client win claim is fine for this demo.
                io.to(roomId).emit('room_updated', room);
            }
        }
    });

    socket.on('declare_win', ({ roomId, playerId }) => {
        const room = rooms.get(roomId);
        if (room && room.status !== 'WON') {
            const player = room.players.find(p => p.id === playerId);
            if (player) {
                room.status = 'WON';
                room.winner = player.name;
                io.to(roomId).emit('room_updated', room);
                io.to(roomId).emit('game_won', { winner: player.name });
            }
        }
    });

    // Restart game
    socket.on('restart_game', ({ roomId }) => {
        const room = rooms.get(roomId);
        if (room) {
            room.status = 'WAITING';
            room.drawnNumbers = [];
            room.winner = null;
            room.players.forEach(p => {
                p.board = [];
            });
            io.to(roomId).emit('room_updated', room);
            io.to(roomId).emit('game_restarted');
        }
    });

    // Kick player
    socket.on('kick_player', ({ roomId, playerId }) => {
        const room = rooms.get(roomId);
        if (room) {
            room.players = room.players.filter(p => p.id !== playerId);
            io.to(roomId).emit('room_updated', room);

            // Optionally notify the kicked user specifically if their socket is still connected?
            // The client side will see they are no longer in room.players and handle it (redirect or show msg)
        }
    });

    socket.on('disconnect', () => {
        // Handle disconnects? Keep player in room for now to allow reconnects.
        console.log('User disconnected:', socket.id);
    });
    // Middleware to update room activity timestamp on every relevant event
    socket.onAny((eventName, ...args) => {
        // Most events pass an object { roomId, ... } as the first argument
        if (args.length > 0 && typeof args[0] === 'object' && args[0].roomId) {
            const { roomId } = args[0];
            const room = rooms.get(roomId);
            if (room) {
                room.lastUpdated = Date.now();
            }
        }
    });
});

// Cleanup stale rooms (1 hour inactivity)
setInterval(() => {
    const OneHour = 60 * 60 * 1000;
    const now = Date.now();
    rooms.forEach((room, id) => {
        if (now - room.lastUpdated > OneHour) {
            rooms.delete(id);
            console.log(`Cleaned up stale room: ${id}`);
        }
    });
}, 60 * 1000); // Check every minute

const PORT = process.env.PORT || 3301; // Avoid 3000 conflicts mostly
server.listen(PORT, () => {
    console.log(`SERVER RUNNING ON PORT ${PORT}`);
});
