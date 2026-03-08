import React, { useState } from 'react'

interface Props {
  onBack: () => void
  onContactAdded: () => void
}

export function AddContactScreen({ onBack, onContactAdded }: Props) {
  const [jsonInput, setJsonInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState(false)

  const handleAdd = async () => {
    setError('')
    setSuccess(false)

    let card: {
      userId?: string
      displayName?: string
      publicKey?: string
      deviceId?: string
      relayUrl?: string
      version?: number
    }

    try {
      card = JSON.parse(jsonInput.trim())
    } catch {
      setError('JSON tidak valid. Tempel ContactCard yang diberikan teman Anda.')
      return
    }

    if (
      !card.userId ||
      !card.displayName ||
      !card.publicKey ||
      !card.deviceId ||
      card.version !== 1
    ) {
      setError('Format ContactCard salah. Pastikan berisi userId, displayName, publicKey, deviceId, dan version: 1.')
      return
    }

    setLoading(true)
    try {
      await window.electronAPI.addContact({
        userId: card.userId,
        displayName: card.displayName,
        publicKey: card.publicKey,
        deviceId: card.deviceId,
        relayUrl: card.relayUrl,
      })
      setSuccess(true)
      setJsonInput('')
      setTimeout(() => onContactAdded(), 800)
    } catch (e) {
      setError('Gagal menambahkan kontak. Coba lagi.')
      console.error(e)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={styles.container}>
      <div style={styles.card}>
        <div style={styles.header}>
          <button style={styles.backBtn} onClick={onBack}>← Kembali</button>
          <h2 style={styles.title}>Tambah Kontak</h2>
        </div>

        <p style={styles.desc}>
          Tempel JSON <strong>ContactCard</strong> yang diberikan teman Anda.
          Mereka bisa mendapatkannya dari menu <em>Profil Saya</em>.
        </p>

        <textarea
          style={styles.textarea}
          placeholder={'{\n  "userId": "...",\n  "displayName": "...",\n  "publicKey": "...",\n  "deviceId": "...",\n  "version": 1\n}'}
          value={jsonInput}
          onChange={(e) => setJsonInput(e.target.value)}
          rows={10}
        />

        {error && <p style={styles.error}>{error}</p>}
        {success && <p style={styles.success}>Kontak berhasil ditambahkan!</p>}

        <button
          style={{
            ...styles.button,
            opacity: loading || !jsonInput.trim() ? 0.5 : 1,
            cursor: loading || !jsonInput.trim() ? 'not-allowed' : 'pointer',
          }}
          onClick={handleAdd}
          disabled={loading || !jsonInput.trim()}
        >
          {loading ? 'Menambahkan...' : 'Tambah Kontak'}
        </button>
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
    backgroundColor: '#f0f0f0',
    padding: 24,
  },
  card: {
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 32,
    width: '100%',
    maxWidth: 500,
    boxShadow: '0 4px 20px rgba(0,0,0,0.1)',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    marginBottom: 20,
  },
  backBtn: {
    background: 'none',
    border: 'none',
    fontSize: 14,
    color: '#075E54',
    cursor: 'pointer',
    fontWeight: 600,
    padding: 0,
  },
  title: {
    fontSize: 20,
    fontWeight: 700,
    color: '#111',
    margin: 0,
  },
  desc: {
    fontSize: 14,
    color: '#666',
    lineHeight: 1.6,
    marginBottom: 16,
  },
  textarea: {
    width: '100%',
    padding: 12,
    borderRadius: 8,
    border: '1px solid #ddd',
    fontSize: 13,
    fontFamily: 'monospace',
    resize: 'vertical',
    outline: 'none',
    boxSizing: 'border-box',
    marginBottom: 12,
  },
  error: { color: '#e53e3e', fontSize: 13, marginBottom: 12 },
  success: { color: '#25D366', fontSize: 13, fontWeight: 600, marginBottom: 12 },
  button: {
    display: 'block',
    width: '100%',
    padding: 13,
    backgroundColor: '#25D366',
    color: '#fff',
    border: 'none',
    borderRadius: 10,
    fontSize: 16,
    fontWeight: 600,
  },
}
