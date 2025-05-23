import express from 'express'
import logger from 'morgan'
import { Server } from 'socket.io'
import { createServer } from 'node:http'
import mysql from 'mysql2/promise'
import bcrypt from 'bcrypt'
import mongoose from 'mongoose'
import { Message } from './models/message.js'
// import { timeStamp } from 'node:console'

const Port = process.env.PORT ?? 3000
const app = express()
const server = createServer(app)
const io = new Server(server)

app.use(logger('dev'))
app.use(express.json())

app.post('/api/register', async (req, res) => {
    const { username, password } = req.body

    if (!username || !password) {
        return res.status(400).json({error: 'Username and password are required'})
    }

    try {
        const hashedPassword = await bcrypt.hash(password, 10)
        await db.execute(
            'INSERT INTO users (username, password) VALUES (?, ?)',
            [username, hashedPassword]
        )
        res.status(201).json({message: 'User registered successfully'})
    } catch (err) {
        if (err.code == 'ER_DUP_ENTRY') {
            return res.status(409).json({error: 'Username already exists'})
        } else {
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
            'SELECT * FROM users WHERE username = ?',
            [username]
        );
        const user = users[0];

        if (!user || !(await bcrypt.compare(password, user.password))) {
            return res.status(401).json({ error: 'Invalid username or password' });
        }

        res.status(200).json({ username });
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
        try {
            await mongoose.connect('mongodb://localhost:27017/chat_app_mongo');
                console.log('✅ Connected to MongoDB');
            } catch (err) {
                console.error('❌ MongoDB connection failed:', err);
            }

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
            }

        const rooms = new Set()

        io.on('connection', async (socket) => {
            console.log('A user has connected')

            const joinedRooms = new Set()

            socket.on('join room', async (room) => {
                socket.join(room);
                joinedRooms.add(room);
                rooms.add(room);
                console.log(`${socket.id} joined room: ${room}`);

                socket.emit('joined room', Array.from(joinedRooms));

            
                try {
                    // const [rows] = await db.execute(
                    //     'SELECT username, content, timestamp FROM messages WHERE room = ? ORDER BY timestamp DESC LIMIT 50',
                    //     [room]
                    // );
                    const recentMessages = await Message.find({ room }).sort({ timestamp: -1 }).limit(50);
                    socket.emit('chat history', recentMessages.reverse());
                } catch (err) {
                    console.error('Error fetching messages:', err);
                }
            });
            

            socket.on('disconnect', () => {
                console.log('A user has disconnected')
            })

            socket.on('chat message', async (msg) => {
                const { username, content, room } = msg;
            
                // Debug print values
                console.log('Received chat message:', { username, content, room });
            
                if (!username || !content || !room) {
                    console.error('Message or username or room is missing');
                    return;
                }
            
                try {
                    const mongoMsg = new Message({username, content, room})
                    await mongoMsg.save()
                    // const [result] = await db.execute(
                    //     'INSERT INTO messages (username, content, room) VALUES (?, ?, ?)',
                    //     [username, content, room]
                    // );
                    // const insertedId = result.insertId;
                    io.to(room).emit('chat message', { username, content, room, timeStamp: mongoMsg.timestamp });
                } catch (err) {
                    console.error('Error inserting message:', err);
                }
            });
            

            socket.on('get rooms', async () => {
                socket.emit('room list', Array.from(rooms));
                socket.emit('joined room', Array.from(joinedRooms));
                try {
                    const [rows] = await db.execute('SELECT DISTINCT room FROM messages');
                    const roomsNames = rows.map(row => row.room);
                    socket.emit('rooms list', roomsNames);
                } catch (err) {
                    console.error('Error fetching rooms:', err);
                }
            });

            // Handle message recovery from the server
            if (!socket.recovered) {
                try {
                    const serverOffset = socket.handshake.auth.serverOffset ?? 0
                    const [rows] = await db.execute(
                        'SELECT id, username, content FROM messages WHERE id > ? ORDER BY id ASC',
                        [serverOffset]
                    )

                    rows.forEach(row => {
                        socket.emit('chat message', {
                            username: row.username,
                            content: row.content,
                            id: row.id
                        })
                    })
                } catch (err) {
                    console.error('Error fetching messages:', err)
                }
            }

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
