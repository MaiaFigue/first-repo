import mongoose from 'mongoose'

const messageSchema = new mongoose.Schema({
  username: String,
  content: String,
  room: String,
  timestamp: {
    type: Date,
    default: Date.now
  },
  type: { 
    type: String,
    default: 'user' }
})

export const Message = mongoose.model('Message', messageSchema)
