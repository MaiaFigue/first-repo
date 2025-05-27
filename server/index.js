import express from 'express'
import logger from 'morgan'
import { Server } from 'socket.io'
import { createServer } from 'node:http'
import mysql from 'mysql2/promise'
import bcrypt from 'bcrypt'
import mongoose from 'mongoose'
import { Message } from './models/message.js'

const Port = process.env.PORT ?? 3000
const app = express()
const server = createServer(app)
const io = new Server(server)

app.use(logger('dev'))
app.use(express.json())

// --- Authentication Endpoints ---
app.post('/api/register', async (req, res) => {
    const { username, password } = req.body

    if (!username || !password) {
        return res.status(400).json({error: 'Username and password are required'})
    }

    try {
        const hashedPassword = await bcrypt.hash(password, 10)
        const [result] = await db.execute( 
            'INSERT INTO users (username, password) VALUES (?, ?)',
            [username, hashedPassword]
        )
        // The result object for INSERT queries often has an 'insertId' property
        const newUserId = result.insertId; 
        
        // Return the username and the newly generated userId
        res.status(201).json({message: 'User registered successfully', username: username, userId: newUserId}) 
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({error: 'Username already exists'})
        } else {
            console.error('Registration error:', err);
            return res.status(500).json({error: 'Internal server error'})
        }
    }
})

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password are required' });
    }

    try {
        const [users] = await db.execute(
            'SELECT id, username, password FROM users WHERE username = ?',
            [username]
        );
        const user = users[0];

        if (!user || !(await bcrypt.compare(password, user.password))) {
            return res.status(401).json({ error: 'Invalid username or password' });
        }

        res.status(200).json({ username: user.username, userId: user.id });
    } catch (err) {
        console.error('Login error:', err);
        return res.status(500).json({ error: 'Internal server error' });
    }
});


app.get('/', (req, res) => {
    res.sendFile(process.cwd() + '/client/index.html')
})

let db

async function startServer() {
    try {
        // --- MongoDB Connection ---
        try {
            await mongoose.connect('mongodb://localhost:27017/chat_app_mongo');
            console.log('✅ Connected to MongoDB');
        } catch (err) {
            console.error('❌ MongoDB connection failed:', err);
            process.exit(1);
        }
        // --- MySQL Connection ---
        try {
            db = await mysql.createConnection({
                host: 'localhost',
                user: 'root',
                password: 'maiafigue4',
                database: 'chat_app',
                connectTimeout: 20000
            });
            console.log('✅ Connected to MySQL');
        } catch (err) {
            console.error('❌ MySQL connection failed:', err);
            process.exit(1);
        }

        // --- Socket.IO Connection Logic ---
        io.on('connection', async (socket) => {
            console.log('A user has connected')

            const { username, userId } = socket.handshake.auth;

            if (!username || !userId) {
                console.error('Unauthenticated socket attempted to connect or userId/username is missing. Disconnecting.');
                socket.disconnect(true);
                return;
            }

            socket.username = username;
            socket.userId = userId;
            console.log(`User connected: ${username} (ID: ${userId})`);

            try {
                const [rows] = await db.execute(
                    'SELECT room_name FROM user_rooms WHERE user_id = ?',
                    [socket.userId]
                );
                const joinedRoomsFromDB = rows.map(row => row.room_name);
                console.log(`User ${socket.username} (ID: ${socket.userId}) rejoined rooms:`, joinedRoomsFromDB);

                joinedRoomsFromDB.forEach(room => {
                    socket.join(room);
                });

                socket.emit('joined rooms', joinedRoomsFromDB);
            } catch (err) {
                console.error('Error fetching joined rooms from MySQL on connect:', err);
                socket.emit('error', 'Failed to retrieve your joined rooms on connect');
            }

            // --- 'join room' handler ---
            socket.on('join room', async (roomName) => {
                if (!roomName) {
                    console.error('Attempted to join an empty room name.');
                    return;
                }

                // Check if the user is already in the room
                const wasAlreadyInRoom = socket.rooms.has(roomName); 

                try {
                    await db.execute(
                        'INSERT IGNORE INTO user_rooms (user_id, room_name) VALUES (?, ?)',
                        [socket.userId, roomName]
                    );
                    socket.join(roomName);
                    console.log(`${socket.username} (ID: ${socket.userId}) joined room: ${roomName}`);

                    if (!wasAlreadyInRoom) { 
                        const systemJoinMessage = new Message({
                            username: socket.username,
                            content: 'has joined the room', 
                            room: roomName,
                            type: 'system', 
                            timestamp: new Date().toISOString()
                        });
                        await systemJoinMessage.save();

                        // --- Broadcast system 'join' message to others in the room ---
                        socket.broadcast.to(roomName).emit('system message', {
                            username: systemJoinMessage.username,
                            content: systemJoinMessage.content,
                            room: systemJoinMessage.room,
                            timestamp: systemJoinMessage.timestamp,
                            type: systemJoinMessage.type
                        });
                    }

                    const recentMessages = await Message.find({ room: roomName }).sort({ timestamp: 1 }).limit(50);
                    const historyToSend = recentMessages.map(msg => ({
                        username: msg.username,
                        content: msg.content,
                        room: msg.room,
                        timestamp: msg.timestamp ? msg.timestamp.toISOString() : undefined,
                        type: msg.type 
                    }));
                    socket.emit('chat history', historyToSend);

                    const [updatedRows] = await db.execute('SELECT room_name FROM user_rooms WHERE user_id = ?', [socket.userId]);
                    const updatedJoinedRooms = updatedRows.map(row => row.room_name);
                    socket.emit('joined rooms', updatedJoinedRooms);

                } catch (err) {
                    console.error(`Error joining room ${roomName} for ${socket.username} (MySQL/Mongo):`, err);
                    socket.emit('error', 'Failed to join room.');
                }
            });
            
            // --- 'leave room' handler ---
            socket.on('leave room', async (roomName) => {
                if (!roomName) {
                    console.error('Attempted to leave an empty room name.');
                    return;
                }
                try {
                    await db.execute(
                        'DELETE FROM user_rooms WHERE user_id = ? AND room_name = ?',
                        [socket.userId, roomName]
                    );

                    socket.leave(roomName);
                    console.log(`${socket.username} (ID: ${socket.userId}) left room: ${roomName}`);

                    const systemLeaveMessage = new Message({
                        username: socket.username,
                        content: 'has left the room', 
                        room: roomName,
                        type: 'system', 
                        timestamp: new Date().toISOString()
                    });
                    await systemLeaveMessage.save();

                    // --- Broadcast system 'leave' message to others in the room ---
                    socket.broadcast.to(roomName).emit('system message',{
                        username: systemLeaveMessage.username,
                        content: systemLeaveMessage.content, 
                        room: roomName,
                        timestamp: systemLeaveMessage.timestamp, // Already ISO string from mongoose
                        type: systemLeaveMessage.type 
                    });

                    const [updatedRows] = await db.execute('SELECT room_name FROM user_rooms WHERE user_id = ?', [socket.userId]);
                    const updatedJoinedRooms = updatedRows.map(row => row.room_name);
                    socket.emit('joined rooms', updatedJoinedRooms); 

                } catch (err) {
                    console.error(`Error leaving room ${roomName} for ${socket.username} (MySQL):`, err);
                    socket.emit('error', 'Failed to leave room.');
                }
            });

            socket.on('disconnect', () => {
                console.log(`User ${socket.username} (ID: ${socket.userId}) is disconnecting.`)

                for (const room of socket.rooms) {
                    if (room !== socket.id) { // Ensure we don't send to the disconnecting socket's own ID room
                        const systemDisconnectMessage = new Message({ 
                            username: socket.username,
                            content: 'has disconnected', // Changed content for clarity on disconnect vs. leave
                            room: room,
                            type: 'system',
                            timestamp: new Date().toISOString()
                        });
                        systemDisconnectMessage.save().catch(err => console.error("Error saving disconnect system message:", err)); // Save to DB

                        socket.broadcast.to(room).emit('system message',{
                            type: systemDisconnectMessage.type, 
                            username: systemDisconnectMessage.username,
                            content: systemDisconnectMessage.content,
                            room: room,
                            timestamp: systemDisconnectMessage.timestamp 
                        });
                    }
                }
            })

            // --- 'chat message' handler ---
            socket.on('chat message', async (msg, callback) => {
                const { username, content, room, timestamp, tempId } = msg; 
            
                if (!username || !content || !room) {
                    console.error('Message, username or room is missing', {username, content, room});
                    if (typeof callback === 'function') {
                        callback({status:  'error', message: 'Missing message'});
                        
                    }
                    return;
                }
            
                try {
                    const serverTimestamp = new Date();

                    const mongoMsg = new Message({username, content, room, timestamp: serverTimestamp});
                    await mongoMsg.save()
                    const messageToSend = {
                        username: mongoMsg.username,
                        content: mongoMsg.content,
                        room: mongoMsg.room,
                        timestamp: mongoMsg.timestamp.toISOString(),
                        tempId: tempId
                    }
                    io.to(room).emit('chat message', messageToSend);
                } catch (err) {
                    console.error('Error inserting message into MongoDB:', err);
                    if (typeof callback === 'function') {
                        callback({status: 'error', message: 'Failed to send message'});
                    }
                }
            });
            
            // --- 'get rooms' handler ---
            socket.on('get rooms', async () => {

                try {
                    const [rows] = await db.execute(
                        'SELECT room_name FROM user_rooms WHERE user_id = ?', 
                        [socket.userId]
                    );
                    const joinedRoomsFromDB = rows.map(row => row.room_name);
                    console.log(`User ${socket.username} (ID: ${socket.userId}) explicitly requested rooms. Sending: `, joinedRoomsFromDB);
                    socket.emit('joined rooms', joinedRoomsFromDB);
                } catch (err) { 
                    console.error('Error fetching joined rooms from MySQL (explicit request):', err);
                    socket.emit('error', 'Failed to retrieve your joined rooms.');
                }
            });

        })
        server.listen(Port, () => {
            console.log(`Server is running on ${Port}`)
        })
    } catch (err) {
        console.error('Failed to connect to DB:', err)
        process.exit(1)
    }
}

startServer()