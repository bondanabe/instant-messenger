import { app, BrowserWindow, shell, Tray, Menu, nativeImage, Notification } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { initDatabase, closeDatabase, getDatabase } from './db'
import { registerIpcHandlers } from './ipc/handlers'
import { DesktopConnectionManager } from './transport/ConnectionManager'
import { identity } from '@im/db-schema'
// electron-updater — hanya aktif di production build (app.isPackaged = true)
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { autoUpdater } = require('electron-updater') as typeof import('electron-updater')

let mainWindow: BrowserWindow | null = null
let connectionManager: DesktopConnectionManager | null = null
let tray: Tray | null = null
let isQuitting = false

export function getConnectionManager(): DesktopConnectionManager | null {
  return connectionManager
}

export function setConnectionManager(cm: DesktopConnectionManager): void {
  connectionManager = cm
}

/** Read relay URL from config file, fallback to default */
export function getStoredRelayUrl(): string {
  try {
    const configPath = path.join(app.getPath('userData'), 'config.json')
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
      if (config.relayUrl) return config.relayUrl
    }
  } catch { /* ignore */ }
  return 'https://relay-server-production-25d2.up.railway.app'
}

/** Store relay URL to config file */
export function storeRelayUrl(relayUrl: string): void {
  const configPath = path.join(app.getPath('userData'), 'config.json')
  let config: Record<string, unknown> = {}
  try {
    if (fs.existsSync(configPath)) {
      config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    }
  } catch { /* ignore */ }
  config.relayUrl = relayUrl
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8')
}

/** Stop current CM and start a new one — called when relay URL changes */
export async function restartCM(newRelayUrl?: string): Promise<void> {
  connectionManager?.stop()
  connectionManager = null
  if (newRelayUrl) storeRelayUrl(newRelayUrl)
  await startCM()
}

async function startCM(): Promise<void> {
  const db = getDatabase()
  const rows = await db.select().from(identity).limit(1)
  if (!rows[0]) return // Belum setup

  const id = rows[0]
  const relayUrl = getStoredRelayUrl()
  const publicKey = Buffer.from(id.publicKey as Uint8Array).toString('base64')

  connectionManager = new DesktopConnectionManager(
    id.userId,
    publicKey,
    id.deviceId,
    relayUrl,
  )

  if (mainWindow) connectionManager.setMainWindow(mainWindow)

  // OS notification when window is not focused
  connectionManager.onMessage((msg, fromUserId) => {
    if (mainWindow && !mainWindow.isFocused() && Notification.isSupported()) {
      const notif = new Notification({
        title: fromUserId,
        body: (msg as { content?: string }).content ?? '📎 Pesan baru',
        silent: false,
      })
      notif.on('click', () => {
        mainWindow?.show()
        mainWindow?.focus()
      })
      notif.show()
    }
  })

  await connectionManager.start()
  console.log('[main] ConnectionManager started, relay:', relayUrl)
}

function setupTray(): void {
  const iconPath = path.join(__dirname, '../../assets/tray-icon.png')
  const icon = fs.existsSync(iconPath)
    ? nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 })
    : nativeImage.createEmpty()

  tray = new Tray(icon)
  tray.setToolTip('Instant Messenger')

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Buka',
      click: () => {
        if (mainWindow) {
          mainWindow.show()
          mainWindow.focus()
        } else {
          createWindow()
        }
      },
    },
    { type: 'separator' },
    {
      label: 'Keluar',
      click: () => {
        isQuitting = true
        app.quit()
      },
    },
  ])

  tray.setContextMenu(contextMenu)
  tray.on('click', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) {
        mainWindow.focus()
      } else {
        mainWindow.show()
        mainWindow.focus()
      }
    }
  })
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 800,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#075E54',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,      // keamanan: renderer tidak bisa akses Node.js
      nodeIntegration: false,      // keamanan: tidak expose Node.js ke renderer
      sandbox: true,
    },
  })

  // Buka link eksternal di browser default, bukan di Electron
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  const isDev = process.env['NODE_ENV'] === 'development'

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173')
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  // Hide to tray instead of quitting when window is closed
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault()
      mainWindow?.hide()
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

app.whenReady().then(async () => {
  // Inisialisasi database sebelum window dibuat
  initDatabase()
  registerIpcHandlers()
  createWindow()
  setupTray()

  // Start ConnectionManager jika identitas sudah ada
  await startCM()

  // Auto-update — hanya di production (packaged app)
  if (app.isPackaged) {
    setupAutoUpdater()
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
    else mainWindow?.show()
  })
})

app.on('window-all-closed', () => {
  // Jika ada tray, jangan quit saat window ditutup (minimize to tray)
  if (!tray) {
    connectionManager?.stop()
    closeDatabase()
    if (process.platform !== 'darwin') app.quit()
  }
})

app.on('before-quit', () => {
  isQuitting = true
  connectionManager?.stop()
  closeDatabase()
})

// ─────────────────────────────────────────────────────────────────────────
// AUTO-UPDATER — cek update dari GitHub Releases saat app pertama dibuka
// ─────────────────────────────────────────────────────────────────────────

function setupAutoUpdater(): void {
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('update-available', (info: { version: string }) => {
    mainWindow?.webContents.send('update:available', { version: info.version })
  })

  autoUpdater.on('update-downloaded', (info: { version: string }) => {
    mainWindow?.webContents.send('update:downloaded', { version: info.version })
  })

  autoUpdater.on('error', (err: Error) => {
    console.error('[updater] Error:', err.message)
  })

  // Cek update setelah 3 detik (beri waktu app fully loaded)
  setTimeout(() => {
    autoUpdater.checkForUpdatesAndNotify().catch((err: Error) => {
      console.warn('[updater] Check failed:', err.message)
    })
  }, 3_000)
}

// IPC — renderer meminta restart untuk install update
import { ipcMain } from 'electron'
ipcMain.handle('update:restart', () => {
  autoUpdater.quitAndInstall(false, true)
})
