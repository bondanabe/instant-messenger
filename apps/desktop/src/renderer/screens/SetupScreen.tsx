import React, { useState } from 'react'
import { v4 as uuidv4 } from 'uuid'

interface Props {
  onComplete: () => void
}

export function SetupScreen({ onComplete }: Props) {
  const [displayName, setDisplayName] = useState('')
  const [relayUrl, setRelayUrl] = useState('https://relay-server-production-25d2.up.railway.app')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const handleSetup = async () => {
    const name = displayName.trim()
    if (name.length < 2) {
      setError('Nama minimal 2 karakter')
      return
    }

    setLoading(true)
    setError('')

    try {
      const userId = uuidv4()
      const deviceId = uuidv4()

      // Main process (handlers.ts) yang generate semua kunci kriptografi.
      // Renderer tidak pernah melihat private key.
      await window.electronAPI.createIdentity({
        userId,
        displayName: name,
        deviceId,
        relayUrl,
      })

      // Simpan relay URL ke localStorage (renderer-side cache)
      localStorage.setItem('relayUrl', relayUrl)
      localStorage.setItem('userId', userId)

      // Start ConnectionManager di main process
      await window.electronAPI.startCM({ relayUrl })

      onComplete()
    } catch (e) {
      setError('Gagal membuat identitas. Coba lagi.')
      console.error(e)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={styles.container}>
      <div style={styles.card}>
        <div style={styles.logo}>💬</div>
        <h1 style={styles.title}>Selamat Datang</h1>
        <p style={styles.subtitle}>
          Identitas dibuat lokal di device ini.
          <br />
          Tidak ada akun yang disimpan di server.
        </p>

        <label style={styles.label}>Nama Tampilan</label>
        <input
          style={styles.input}
          placeholder="Masukkan nama Anda"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSetup()}
          maxLength={50}
          autoFocus
        />

        <label style={styles.label}>Relay Server URL</label>
        <input
          style={styles.input}
          placeholder="wss://your-relay.up.railway.app"
          value={relayUrl}
          onChange={(e) => setRelayUrl(e.target.value)}
        />
        <p style={styles.hint}>
          URL relay server production: https://relay-server-production-25d2.up.railway.app
        </p>

        {error && <p style={styles.error}>{error}</p>}

        <button
          style={{
            ...styles.button,
            opacity: loading || !displayName.trim() ? 0.6 : 1,
            cursor: loading || !displayName.trim() ? 'not-allowed' : 'pointer',
          }}
          onClick={handleSetup}
          disabled={loading || !displayName.trim()}
        >
          {loading ? 'Memproses...' : 'Mulai'}
        </button>

        <p style={styles.privacyNote}>
          🔒 Semua data tersimpan lokal. Server tidak membaca pesan Anda.
        </p>
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    height: '100vh',
    backgroundColor: '#075E54',
    padding: 24,
  },
  card: {
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 40,
    width: '100%',
    maxWidth: 420,
    boxShadow: '0 8px 32px rgba(0,0,0,0.2)',
  },
  logo: { fontSize: 56, textAlign: 'center', marginBottom: 12 },
  title: { fontSize: 26, fontWeight: 700, color: '#111', textAlign: 'center', marginBottom: 8 },
  subtitle: { fontSize: 14, color: '#666', textAlign: 'center', lineHeight: 1.6, marginBottom: 28 },
  label: { display: 'block', fontSize: 13, fontWeight: 600, color: '#333', marginBottom: 6 },
  input: {
    display: 'block',
    width: '100%',
    padding: '11px 14px',
    borderRadius: 8,
    border: '1px solid #ddd',
    fontSize: 15,
    color: '#111',
    marginBottom: 8,
    outline: 'none',
    boxSizing: 'border-box',
  },
  hint: { fontSize: 12, color: '#999', marginBottom: 20 },
  error: { color: '#e53e3e', fontSize: 13, marginBottom: 12 },
  button: {
    display: 'block',
    width: '100%',
    padding: '13px',
    backgroundColor: '#25D366',
    color: '#fff',
    border: 'none',
    borderRadius: 10,
    fontSize: 16,
    fontWeight: 700,
    marginTop: 8,
    transition: 'opacity 0.2s',
  },
  privacyNote: {
    marginTop: 20,
    fontSize: 12,
    color: '#999',
    textAlign: 'center',
    lineHeight: 1.6,
  },
}
