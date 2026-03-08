import React, { useEffect, useState } from 'react'

interface Contact {
  userId: string
  displayName: string
  publicKey: unknown
  addedAt: number
}

interface Props {
  onBack: () => void
  onStartChat: (contactUserId: string, contactName: string) => void
}

export function ContactListScreen({ onBack, onStartChat }: Props) {
  const [contacts, setContacts] = useState<Contact[]>([])
  const [onlineMap, setOnlineMap] = useState<Record<string, boolean>>({})

  useEffect(() => {
    window.electronAPI.listContacts().then((data) => {
      const list = data as Contact[]
      setContacts(list)
      // Check online status for each contact
      list.forEach((c) => {
        window.electronAPI.checkOnline(c.userId).then((online) => {
          setOnlineMap((prev) => ({ ...prev, [c.userId]: online }))
        })
      })
    })
  }, [])

  const handleStartChat = async (contact: Contact) => {
    // For DM, we use the contact's userId as the conversationId
    const conversationId = contact.userId
    onStartChat(conversationId, contact.displayName)
  }

  return (
    <div style={styles.container}>
      <div style={styles.panel}>
        <div style={styles.header}>
          <button style={styles.backBtn} onClick={onBack}>← Kembali</button>
          <h2 style={styles.title}>Kontak</h2>
          <span style={styles.count}>{contacts.length}</span>
        </div>

        <div style={styles.list}>
          {contacts.length === 0 ? (
            <div style={styles.empty}>
              <div style={styles.emptyIcon}>👥</div>
              <div style={styles.emptyText}>Belum ada kontak</div>
              <div style={styles.emptySubText}>
                Tambahkan kontak dari menu utama
              </div>
            </div>
          ) : (
            contacts.map((contact) => (
              <div
                key={contact.userId}
                style={styles.contactItem}
                onClick={() => handleStartChat(contact)}
              >
                <div style={styles.avatarWrap}>
                  <div style={styles.avatar}>
                    <span style={styles.avatarLetter}>
                      {contact.displayName.charAt(0).toUpperCase()}
                    </span>
                  </div>
                  {onlineMap[contact.userId] && (
                    <div style={styles.onlineDot} />
                  )}
                </div>
                <div style={styles.contactInfo}>
                  <div style={styles.contactName}>{contact.displayName}</div>
                  <div style={styles.contactId}>
                    {onlineMap[contact.userId] ? 'Online' : 'Offline'}
                  </div>
                </div>
                <div style={styles.chatIcon}>💬</div>
              </div>
            ))
          )}
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
  },
  panel: {
    width: '100%',
    maxWidth: 500,
    backgroundColor: '#fff',
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '16px 20px',
    backgroundColor: '#075E54',
  },
  backBtn: {
    background: 'none',
    border: 'none',
    fontSize: 14,
    color: '#fff',
    cursor: 'pointer',
    fontWeight: 600,
    padding: 0,
  },
  title: { fontSize: 18, fontWeight: 700, color: '#fff', margin: 0, flex: 1 },
  count: {
    backgroundColor: 'rgba(255,255,255,0.2)',
    color: '#fff',
    fontSize: 12,
    fontWeight: 600,
    padding: '3px 8px',
    borderRadius: 10,
  },
  list: { flex: 1, overflowY: 'auto' },
  contactItem: {
    display: 'flex',
    alignItems: 'center',
    padding: '14px 20px',
    cursor: 'pointer',
    borderBottom: '1px solid #f0f0f0',
    transition: 'background 0.15s',
  },
  avatarWrap: { position: 'relative', marginRight: 14 },
  avatar: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: '#075E54',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarLetter: { color: '#fff', fontSize: 18, fontWeight: 600 },
  onlineDot: {
    position: 'absolute',
    bottom: 1,
    right: 1,
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: '#25D366',
    border: '2px solid #fff',
  },
  contactInfo: { flex: 1 },
  contactName: { fontSize: 16, fontWeight: 600, color: '#111' },
  contactId: { fontSize: 13, color: '#999', marginTop: 2 },
  chatIcon: { fontSize: 20, opacity: 0.5 },
  empty: { padding: 40, textAlign: 'center' },
  emptyIcon: { fontSize: 48, marginBottom: 12 },
  emptyText: { fontSize: 16, fontWeight: 600, color: '#333', marginBottom: 8 },
  emptySubText: { fontSize: 13, color: '#999' },
}
