import { createServer } from 'node:http'
import cors from 'cors'
import express from 'express'
import { Server } from 'socket.io'

const port = Number.parseInt(process.env.PORT ?? '3001', 10)
const allowedOrigin = process.env.APP_ORIGIN ?? 'http://localhost:3000'

const app = express()
app.disable('x-powered-by')
app.use(cors({ origin: allowedOrigin }))
app.use(express.json({ limit: '32kb' }))

app.get('/health', (_request, response) => {
  response.json({ service: 'swapduel', status: 'ok' })
})

const httpServer = createServer(app)
const io = new Server(httpServer, {
  cors: { origin: allowedOrigin },
  maxHttpBufferSize: 64 * 1024,
})

io.on('connection', (socket) => {
  socket.on('ping', (clientTimestamp: unknown) => {
    if (typeof clientTimestamp !== 'number' || !Number.isFinite(clientTimestamp)) {
      return
    }

    socket.emit('pong', {
      clientTimestamp,
      serverTimestamp: Date.now(),
    })
  })
})

httpServer.listen(port, () => {
  console.log(`Swapduel server listening on port ${port}`)
})
