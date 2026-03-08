import express from 'express'
import { createServer } from 'node:http'
import { Server } from 'socket.io'
import { createPresenceService } from './presence.js'
import { createMessageGateway } from './gateway.js'

const app = express()
const httpServer = createServer(app)

// ─────────────────────────────────────────────────────────────────
// ALLOWED ORIGINS — diset via env var di Railway
// Format: ALLOWED_ORIGINS=https://app.example.com,myapp://
// Kosongkan untuk terima semua origin (development only)
// ─────────────────────────────────────────────────────────────────
const allowedOrigins: string | string[] = process.env['ALLOWED_ORIGINS']
  ? process.env['ALLOWED_ORIGINS'].split(',').map((o) => o.trim())
  : '*'

const io = new Server(httpServer, {
  cors: {
    origin: allowedOrigins,
    methods: ['GET', 'POST'],
  },
  transports: ['websocket', 'polling'],
  maxHttpBufferSize: 64 * 1024,   // 64KB max per event
  pingTimeout: 60_000,
  pingInterval: 25_000,
  connectTimeout: 10_000,
})

// ─────────────────────────────────────────────────────────────────
// PRESENCE SERVICE — in-memory, tidak ada database
// ─────────────────────────────────────────────────────────────────
const presence = createPresenceService()

// ─────────────────────────────────────────────────────────────────
// REST ENDPOINTS
// ─────────────────────────────────────────────────────────────────

// Health check — digunakan Railway untuk uptim monitoring
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: Date.now(),
    onlineUsers: presence.getOnlineCount(),
    // Sengaja tidak log detail user untuk privasi
  })
})

app.get('/', (_req, res) => {
  res.json({ name: 'instant-messenger relay', version: '1.0.0' })
})

// ─────────────────────────────────────────────────────────────────
// SOCKET.IO GATEWAY
// ─────────────────────────────────────────────────────────────────
createMessageGateway(io, presence)

// ─────────────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────────────
const PORT = Number(process.env['PORT'] ?? 3000)

httpServer.listen(PORT, () => {
  console.log(`[relay] Server running on port ${PORT}`)
  console.log(`[relay] Origins: ${JSON.stringify(allowedOrigins)}`)
})

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[relay] SIGTERM received, shutting down...')
  httpServer.close(() => process.exit(0))
})

// ─────────────────────────────────────────────────────────────────
// GLOBAL ERROR HANDLERS — cegah crash tak terduga, log + restart via Railway
// ─────────────────────────────────────────────────────────────────

process.on('uncaughtException', (err) => {
  console.error(JSON.stringify({
    ts: new Date().toISOString(),
    event: 'uncaughtException',
    error: err.message,
    stack: err.stack,
  }))
  process.exit(1) // Railway / supervisor akan restart otomatis
})

process.on('unhandledRejection', (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason)
  const stack = reason instanceof Error ? reason.stack : undefined
  console.error(JSON.stringify({
    ts: new Date().toISOString(),
    event: 'unhandledRejection',
    error: message,
    stack,
  }))
  // Tidak exit — agar koneksi yang sedang berjalan tidak putus
})
