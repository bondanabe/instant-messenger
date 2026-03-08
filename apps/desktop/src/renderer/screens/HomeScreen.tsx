import React, { useEffect, useState } from 'react'

interface Conversation {
  id: string
  type: string
  name: string | null
  lastMsgPreview: string | null
  lastMsgAt: number | null
  unreadCount: number
}

interface Props {
  connectionMode: string
  onOpenChat: (conversationId: string, contactName: string) => void
  onAddContact: () => void
  onOpenProfile: () => void
  onOpenContacts: () => void
  onOpenSettings: () => void
}

export function HomeScreen({ connectionMode, onOpenChat, onAddContact, onOpenProfile, onOpenContacts, onOpenSettings }: Props) {
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [search, setSearch] = useState('')

  useEffect(() => {
    window.electronAPI.listConversations().then((data) => {
      setConversations(data as Conversation[])
    })
  }, [])

  const connectionLabel: Record<string, string> = {
    internet: 'Online',
    lan: 'LAN',
    wifi_direct: 'WiFi Direct',
    bluetooth: 'Bluetooth',
    offline: 'Offline',
  }

  const connectionColor: Record<string, string> = {
    internet: '#25D366',
    lan: '#FFA500',
    wifi_direct: '#FFA500',
    bluetooth: '#007AFF',
    offline: '#999',
  }

  const filtered = conversations.filter((c) =>
    c.name?.toLowerCase().includes(search.toLowerCase()),
  )

  return (
    <div style={styles.container}>
      {/* Sidebar */}
      <div style={styles.sidebar}>
        {/* Header */}
        <div style={styles.header}>
          <span style={styles.headerTitle}>Messenger</span>
          <div style={styles.headerActions}>
            <span
              style={{
                ...styles.badge,
                backgroundColor: connectionColor[connectionMode] ?? '#999',
              }}
            >
              {connectionLabel[connectionMode] ?? connectionMode}
            </span>
          </div>
        </div>

        {/* Action buttons */}
        <div style={styles.actionBar}>
          <button style={styles.actionBtn} onClick={onOpenContacts}>
            👥 Kontak
          </button>
          <button style={styles.actionBtn} onClick={onAddContact}>
            ➕ Tambah
          </button>
          <button style={styles.actionBtn} onClick={onOpenProfile}>
            👤 Profil
          </button>
          <button style={styles.actionBtn} onClick={onOpenSettings}>
            ⚙️ Setelan
          </button>
        </div>

        {/* Search */}
        <div style={styles.searchBox}>
          <input
            style={styles.searchInput}
            placeholder="Cari percakapan..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        {/* List */}
        <div style={styles.list}>
          {filtered.length === 0 ? (
            <div style={styles.empty}>
              <div style={styles.emptyText}>Belum ada percakapan</div>
              <div style={styles.emptySubText}>
                Tambahkan kontak via QR Code
              </div>
            </div>
          ) : (
            filtered.map((conv) => (
              <div
                key={conv.id}
                style={styles.convItem}
                onClick={() => onOpenChat(conv.id, conv.name ?? 'Unknown')}
              >
                <div style={styles.avatar}>
                  <span style={styles.avatarLetter}>
                    {(conv.name ?? '?').charAt(0).toUpperCase()}
                  </span>
                </div>
                <div style={styles.convInfo}>
                  <div style={styles.convRow}>
                    <span style={styles.convName}>{conv.name ?? 'Unknown'}</span>
                    {conv.lastMsgAt && (
                      <span style={styles.convTime}>{formatTime(conv.lastMsgAt)}</span>
                    )}
                  </div>
                  <div style={styles.convRow}>
                    <span style={styles.convPreview}>
                      {conv.lastMsgPreview ?? 'Tidak ada pesan'}
                    </span>
                    {conv.unreadCount > 0 && (
                      <span style={styles.unreadBadge}>{conv.unreadCount}</span>
                    )}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Main area (empty state) */}
      <div style={styles.main}>
        <div style={styles.welcomeIcon}>💬</div>
        <div style={styles.welcomeText}>Pilih percakapan untuk mulai chat</div>
      </div>
    </div>
  )
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })
  }
  return d.toLocaleDateString('id-ID', { day: '2-digit', month: 'short' })
}

const styles: Record<string, React.CSSProperties> = {
  container: { display: 'flex', height: '100vh', overflow: 'hidden' },
  sidebar: {
    width: 320,
    minWidth: 280,
    borderRight: '1px solid #e0e0e0',
    display: 'flex',
    flexDirection: 'column',
    backgroundColor: '#fff',
  },
  header: {
    backgroundColor: '#075E54',
    padding: '16px 16px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    WebkitAppRegion: 'drag',
  },
  headerTitle: { color: '#fff', fontSize: 18, fontWeight: 700 },
  headerActions: { display: 'flex', alignItems: 'center', gap: 8 },
  badge: { color: '#fff', fontSize: 11, fontWeight: 600, padding: '3px 8px', borderRadius: 10 },
  actionBar: {
    display: 'flex',
    borderBottom: '1px solid #e0e0e0',
    backgroundColor: '#fafafa',
  },
  actionBtn: {
    flex: 1,
    padding: '10px 4px',
    border: 'none',
    background: 'none',
    fontSize: 13,
    fontWeight: 600,
    color: '#075E54',
    cursor: 'pointer',
    transition: 'background 0.15s',
  },
  searchBox: { padding: '8px 12px', borderBottom: '1px solid #f0f0f0' },
  searchInput: {
    width: '100%',
    padding: '8px 12px',
    borderRadius: 20,
    border: '1px solid #ddd',
    fontSize: 14,
    outline: 'none',
    backgroundColor: '#f5f5f5',
  },
  list: { flex: 1, overflowY: 'auto' },
  convItem: {
    display: 'flex',
    alignItems: 'center',
    padding: '12px 16px',
    cursor: 'pointer',
    borderBottom: '1px solid #f5f5f5',
    transition: 'background 0.15s',
  },
  avatar: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: '#075E54',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
    flexShrink: 0,
  },
  avatarLetter: { color: '#fff', fontSize: 18, fontWeight: 600 },
  convInfo: { flex: 1, minWidth: 0 },
  convRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 2 },
  convName: { fontSize: 15, fontWeight: 600, color: '#111', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  convTime: { fontSize: 11, color: '#999', flexShrink: 0, marginLeft: 8 },
  convPreview: { fontSize: 13, color: '#666', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 },
  unreadBadge: {
    backgroundColor: '#25D366',
    color: '#fff',
    fontSize: 11,
    fontWeight: 700,
    padding: '2px 7px',
    borderRadius: 10,
    marginLeft: 8,
    flexShrink: 0,
  },
  empty: { padding: 32, textAlign: 'center' },
  emptyText: { fontSize: 16, fontWeight: 600, color: '#333', marginBottom: 8 },
  emptySubText: { fontSize: 13, color: '#999' },
  main: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#f0f0f0',
    gap: 12,
  },
  welcomeIcon: { fontSize: 64 },
  welcomeText: { fontSize: 16, color: '#666' },
}
