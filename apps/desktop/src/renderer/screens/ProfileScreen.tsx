import React, { useEffect, useState } from 'react'

interface IdentityInfo {
  userId: string
  displayName: string
  publicKey: string | Uint8Array
  deviceId: string
}

interface Props {
  onBack: () => void
}

export function ProfileScreen({ onBack }: Props) {
  const [identity, setIdentity] = useState<IdentityInfo | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    window.electronAPI.getIdentity().then((id) => {
      setIdentity(id as IdentityInfo)
    })
  }, [])

  const getContactCard = (): string => {
    if (!identity) return ''
    const relayUrl = localStorage.getItem('relayUrl') || ''
    const pubKey = identity.publicKey instanceof Uint8Array
      ? btoa(String.fromCharCode(...identity.publicKey))
      : String(identity.publicKey)

    return JSON.stringify(
      {
        userId: identity.userId,
        displayName: identity.displayName,
        publicKey: pubKey,
        deviceId: identity.deviceId,
        relayUrl: relayUrl || undefined,
        version: 1,
      },
      null,
      2,
    )
  }

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(getContactCard())
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Fallback
      const textarea = document.createElement('textarea')
      textarea.value = getContactCard()
      document.body.appendChild(textarea)
      textarea.select()
      document.execCommand('copy')
      document.body.removeChild(textarea)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  if (!identity) {
    return (
      <div style={styles.container}>
        <div style={styles.loading}>Memuat profil...</div>
      </div>
    )
  }

  return (
    <div style={styles.container}>
      <div style={styles.card}>
        <div style={styles.header}>
          <button style={styles.backBtn} onClick={onBack}>← Kembali</button>
          <h2 style={styles.title}>Profil Saya</h2>
        </div>

        {/* Avatar */}
        <div style={styles.avatarSection}>
          <div style={styles.avatar}>
            <span style={styles.avatarLetter}>
              {identity.displayName.charAt(0).toUpperCase()}
            </span>
          </div>
          <div style={styles.name}>{identity.displayName}</div>
          <div style={styles.userId}>ID: {identity.userId.slice(0, 8)}...</div>
        </div>

        {/* Contact Card */}
        <div style={styles.section}>
          <div style={styles.sectionTitle}>ContactCard (bagikan ke teman)</div>
          <p style={styles.desc}>
            Salin JSON di bawah ini dan kirim ke teman Anda agar mereka bisa menambahkan Anda sebagai kontak.
          </p>
          <pre style={styles.jsonBlock}>{getContactCard()}</pre>

          <button
            style={{
              ...styles.copyBtn,
              backgroundColor: copied ? '#25D366' : '#075E54',
            }}
            onClick={handleCopy}
          >
            {copied ? '✓ Tersalin!' : 'Salin ContactCard'}
          </button>
        </div>
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'flex-start',
    height: '100vh',
    backgroundColor: '#f0f0f0',
    padding: 24,
    overflowY: 'auto',
  },
  loading: { padding: 40, fontSize: 16, color: '#666' },
  card: {
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 32,
    width: '100%',
    maxWidth: 500,
    boxShadow: '0 4px 20px rgba(0,0,0,0.1)',
    marginTop: 20,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    marginBottom: 24,
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
  title: { fontSize: 20, fontWeight: 700, color: '#111', margin: 0 },
  avatarSection: { textAlign: 'center', marginBottom: 28 },
  avatar: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: '#075E54',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
  },
  avatarLetter: { color: '#fff', fontSize: 32, fontWeight: 700 },
  name: { fontSize: 22, fontWeight: 700, color: '#111' },
  userId: { fontSize: 13, color: '#999', marginTop: 4 },
  section: { marginTop: 4 },
  sectionTitle: { fontSize: 14, fontWeight: 700, color: '#075E54', marginBottom: 8 },
  desc: { fontSize: 13, color: '#666', lineHeight: 1.5, marginBottom: 12 },
  jsonBlock: {
    backgroundColor: '#f5f5f5',
    borderRadius: 8,
    padding: 14,
    fontSize: 12,
    fontFamily: 'monospace',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
    border: '1px solid #e0e0e0',
    maxHeight: 220,
    overflowY: 'auto',
    marginBottom: 12,
  },
  copyBtn: {
    display: 'block',
    width: '100%',
    padding: 12,
    color: '#fff',
    border: 'none',
    borderRadius: 10,
    fontSize: 15,
    fontWeight: 600,
    cursor: 'pointer',
    transition: 'background-color 0.2s',
  },
}
