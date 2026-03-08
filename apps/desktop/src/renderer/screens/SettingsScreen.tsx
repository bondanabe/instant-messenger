import React, { useEffect, useState } from 'react'

interface IdentityInfo {
  userId: string
  displayName: string
  deviceId: string
}

interface Props {
  onBack: () => void
}

export function SettingsScreen({ onBack }: Props) {
  const [identity, setIdentity] = useState<IdentityInfo | null>(null)
  const [displayName, setDisplayName] = useState('')
  const [relayUrl, setRelayUrl] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveStatus, setSaveStatus] = useState<'idle' | 'ok' | 'err'>('idle')

  useEffect(() => {
    window.electronAPI.getIdentity().then((id) => {
      const info = id as IdentityInfo
      setIdentity(info)
      setDisplayName(info?.displayName ?? '')
    })
    window.electronAPI.getStoredRelayUrl().then((url) => setRelayUrl(url))
  }, [])

  const handleSave = async () => {
    const name = displayName.trim()
    if (name.length < 2) return
    setSaving(true)
    setSaveStatus('idle')
    try {
      await window.electronAPI.updateIdentityName(name)
      if (relayUrl.trim()) {
        await window.electronAPI.updateRelayUrl(relayUrl.trim())
      }
      setSaveStatus('ok')
      setTimeout(() => setSaveStatus('idle'), 2000)
    } catch {
      setSaveStatus('err')
    } finally {
      setSaving(false)
    }
  }

  if (!identity) {
    return <div style={styles.loading}>Memuat...</div>
  }

  return (
    <div style={styles.container}>
      <div style={styles.panel}>
        {/* Header */}
        <div style={styles.header}>
          <button style={styles.backBtn} onClick={onBack}>←</button>
          <span style={styles.title}>Pengaturan</span>
        </div>

        <div style={styles.body}>
          {/* Profile section */}
          <div style={styles.section}>
            <div style={styles.sectionLabel}>PROFIL</div>

            <div style={styles.avatarSection}>
              <div style={styles.avatar}>
                <span style={styles.avatarLetter}>
                  {(identity.displayName ?? '?').charAt(0).toUpperCase()}
                </span>
              </div>
            </div>

            <label style={styles.label}>Nama Tampilan</label>
            <input
              style={styles.input}
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              maxLength={50}
              placeholder="Masukkan nama Anda"
            />
          </div>

          {/* Network section */}
          <div style={styles.section}>
            <div style={styles.sectionLabel}>JARINGAN</div>

            <label style={styles.label}>Relay Server URL</label>
            <input
              style={styles.input}
              value={relayUrl}
              onChange={(e) => setRelayUrl(e.target.value)}
              placeholder="https://relay-server-production-25d2.up.railway.app"
            />
            <p style={styles.hint}>
              Ganti relay URL lalu simpan. CM akan restart otomatis.
            </p>
          </div>

          {/* Device info */}
          <div style={styles.section}>
            <div style={styles.sectionLabel}>INFO PERANGKAT</div>
            <div style={styles.infoRow}>
              <span style={styles.infoKey}>User ID</span>
              <span style={styles.infoVal}>{identity.userId.slice(0, 16)}…</span>
            </div>
            <div style={styles.infoRow}>
              <span style={styles.infoKey}>Device ID</span>
              <span style={styles.infoVal}>{identity.deviceId.slice(0, 16)}…</span>
            </div>
          </div>

          {saveStatus === 'ok' && (
            <div style={styles.successBanner}>✓ Perubahan disimpan</div>
          )}
          {saveStatus === 'err' && (
            <div style={styles.errorBanner}>✗ Gagal menyimpan</div>
          )}

          <button
            style={{
              ...styles.saveBtn,
              opacity: saving || displayName.trim().length < 2 ? 0.5 : 1,
            }}
            onClick={handleSave}
            disabled={saving || displayName.trim().length < 2}
          >
            {saving ? 'Menyimpan...' : 'Simpan'}
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
    height: '100vh',
    backgroundColor: '#f0f0f0',
    overflowY: 'auto',
  },
  loading: { padding: 40, fontSize: 16, color: '#666', textAlign: 'center' },
  panel: {
    width: '100%',
    maxWidth: 520,
    backgroundColor: '#fff',
    minHeight: '100%',
    display: 'flex',
    flexDirection: 'column',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '14px 20px',
    backgroundColor: '#075E54',
    WebkitAppRegion: 'drag',
  },
  backBtn: {
    background: 'none',
    border: 'none',
    color: '#fff',
    fontSize: 20,
    cursor: 'pointer',
    padding: '2px 6px',
    WebkitAppRegion: 'no-drag',
  },
  title: { color: '#fff', fontSize: 18, fontWeight: 700 },
  body: { padding: 20, display: 'flex', flexDirection: 'column', gap: 0 },
  avatarSection: { display: 'flex', justifyContent: 'center', marginBottom: 20 },
  avatar: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: '#075E54',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarLetter: { color: '#fff', fontSize: 28, fontWeight: 700 },
  section: { marginBottom: 24 },
  sectionLabel: {
    fontSize: 12,
    fontWeight: 700,
    color: '#075E54',
    letterSpacing: 0.8,
    marginBottom: 12,
    textTransform: 'uppercase',
  },
  label: { display: 'block', fontSize: 13, fontWeight: 600, color: '#444', marginBottom: 6 },
  input: {
    display: 'block',
    width: '100%',
    padding: '10px 12px',
    borderRadius: 8,
    border: '1px solid #ddd',
    fontSize: 14,
    outline: 'none',
    boxSizing: 'border-box',
    marginBottom: 6,
  },
  hint: { fontSize: 12, color: '#999', margin: '0 0 8px' },
  infoRow: {
    display: 'flex',
    justifyContent: 'space-between',
    padding: '8px 0',
    borderBottom: '1px solid #f5f5f5',
  },
  infoKey: { fontSize: 13, color: '#666' },
  infoVal: { fontSize: 13, color: '#333', fontFamily: 'monospace' },
  successBanner: {
    backgroundColor: '#d4edda',
    color: '#155724',
    padding: '8px 12px',
    borderRadius: 8,
    fontSize: 13,
    marginBottom: 12,
  },
  errorBanner: {
    backgroundColor: '#f8d7da',
    color: '#721c24',
    padding: '8px 12px',
    borderRadius: 8,
    fontSize: 13,
    marginBottom: 12,
  },
  saveBtn: {
    width: '100%',
    padding: 13,
    backgroundColor: '#25D366',
    color: '#fff',
    border: 'none',
    borderRadius: 10,
    fontSize: 15,
    fontWeight: 600,
    cursor: 'pointer',
  },
}
