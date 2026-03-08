import React, { useEffect, useRef, useState, useCallback } from 'react'

interface Message {
  id: string
  conversationId: string
  senderId: string
  type: string
  content: string | null
  status: string
  createdAt: number
  isDeleted: boolean
  replyToId?: string | null
}

interface Identity {
  userId: string
  displayName: string
}

interface Props {
  conversationId: string
  contactName: string
  connectionMode: string
  onBack: () => void
  onStartAudioCall?: (callId: string) => void
  onStartVideoCall?: (callId: string) => void
}

export function ChatScreen({ conversationId, contactName, connectionMode, onBack, onStartAudioCall, onStartVideoCall }: Props) {
  const [messages, setMessages] = useState<Message[]>([])
  const [identity, setIdentity] = useState<Identity | null>(null)
  const [text, setText] = useState('')
  const [isContactTyping, setIsContactTyping] = useState(false)
  const [contactOnline, setContactOnline] = useState(false)
  const [replyTo, setReplyTo] = useState<Message | null>(null)
  const [hasMore, setHasMore] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const oldestTsRef = useRef<number>(0)

  useEffect(() => {
    window.electronAPI.getIdentity().then((id) => setIdentity(id as Identity))
    loadMessages()
    window.electronAPI.markConversationRead(conversationId)

    // Check if contact is online
    window.electronAPI.checkOnline(conversationId).then((online) => setContactOnline(online))

    // Send read receipt for conversation
    window.electronAPI.sendReadReceipt({ targetUserId: conversationId, messageId: conversationId })

    // Listen for incoming messages untuk conversation ini
    const unsub = window.electronAPI.onIncomingMessage((data) => {
      const { message, fromUserId } = data as {
        message: { id: string; type: string; content?: string; timestamp: number; conversationId?: string; replyToId?: string }
        fromUserId: string
      }
      // Tampilkan hanya jika milik conversation yang sedang terbuka
      if (message.conversationId === conversationId || fromUserId === conversationId) {
        const incoming: Message = {
          id: message.id,
          conversationId,
          senderId: fromUserId,
          type: message.type ?? 'text',
          content: message.content ?? null,
          status: 'delivered',
          createdAt: message.timestamp ?? Date.now(),
          isDeleted: false,
          replyToId: message.replyToId ?? null,
        }
        setMessages((prev) => [...prev, incoming])
        setTimeout(() => bottomRef.current?.scrollIntoView(), 50)

        // Simpan ke DB
        window.electronAPI.saveMessage({
          id: incoming.id,
          conversationId,
          senderId: fromUserId,
          type: incoming.type,
          content: incoming.content,
          status: 'delivered',
          createdAt: incoming.createdAt,
          replyToId: incoming.replyToId,
        })
      }
    })

    // Listen for typing indicators
    const unsubTyping = window.electronAPI.onTyping((data) => {
      if (data.fromUserId === conversationId) {
        setIsContactTyping(data.isTyping)
        if (data.isTyping) {
          setTimeout(() => setIsContactTyping(false), 5000)
        }
      }
    })

    // Listen for read receipts → update message status to 'read'
    const unsubRead = window.electronAPI.onReadReceipt((data) => {
      if (data.fromUserId === conversationId) {
        setMessages((prev) =>
          prev.map((m) =>
            m.senderId !== conversationId && (m.status === 'delivered' || m.status === 'sent')
              ? { ...m, status: 'read' }
              : m,
          ),
        )
      }
    })

    return () => {
      unsub()
      unsubTyping()
      unsubRead()
      window.electronAPI.sendTyping({ targetUserId: conversationId, isTyping: false })
    }
  }, [conversationId])

  async function loadMessages() {
    const rows = await window.electronAPI.listMessages({ conversationId, limit: 50 })
    const sorted = (rows as Message[]).reverse()
    setMessages(sorted)
    if (sorted.length > 0) oldestTsRef.current = sorted[0]!.createdAt
    setHasMore(sorted.length === 50)
    setTimeout(() => bottomRef.current?.scrollIntoView(), 50)
  }

  const loadOlderMessages = useCallback(async () => {
    if (!hasMore || loadingMore || oldestTsRef.current === 0) return
    setLoadingMore(true)
    try {
      const rows = await window.electronAPI.listMessages({
        conversationId,
        limit: 50,
        before: oldestTsRef.current,
      })
      const older = (rows as Message[]).reverse()
      if (older.length > 0) {
        oldestTsRef.current = older[0]!.createdAt
        setMessages((prev) => [...older, ...prev])
      }
      setHasMore(older.length === 50)
    } finally {
      setLoadingMore(false)
    }
  }, [conversationId, hasMore, loadingMore])

  const handleDelete = useCallback(async (messageId: string) => {
    await window.electronAPI.deleteMessage(messageId)
    setMessages((prev) =>
      prev.map((m) => (m.id === messageId ? { ...m, isDeleted: true } : m)),
    )
  }, [])

  // ── Media helpers ──────────────────────────────────────────────────

  const handleSendMedia = useCallback(async (
    dataUri: string,
    type: 'image' | 'audio' | 'file',
    mimeType: string,
    fileName: string,
    sizeBytes: number,
  ) => {
    if (!identity) return
    const now = Date.now()
    const messageId = `${identity.userId}-${now}-${Math.random().toString(36).slice(2, 8)}`

    // File messages carry metadata as JSON; image/audio carry the data URI directly
    const content = type === 'file'
      ? JSON.stringify({ uri: dataUri, name: fileName, size: sizeBytes })
      : dataUri

    const newMsg: Message = {
      id: messageId, conversationId,
      senderId: identity.userId,
      type, content, status: 'pending', createdAt: now, isDeleted: false,
    }
    setMessages((prev) => [...prev, newMsg])
    setTimeout(() => bottomRef.current?.scrollIntoView(), 50)

    await window.electronAPI.saveMessage({
      id: messageId, conversationId, senderId: identity.userId,
      type, content, status: 'pending', createdAt: now,
    })

    const wireMessage = {
      id: messageId, type, senderId: identity.userId,
      conversationId, content, timestamp: now,
    }
    const result = await window.electronAPI.sendMessage({
      targetUserId: conversationId,
      message: wireMessage,
    }) as { status?: string }

    const finalStatus = result?.status === 'delivered' ? 'delivered'
      : result?.status === 'sent' ? 'sent'
      : 'failed'

    setMessages((prev) => prev.map((m) => m.id === messageId ? { ...m, status: finalStatus } : m))
    await window.electronAPI.updateMessageStatus({ messageId, status: finalStatus })
  }, [identity, conversationId])

  const handleAttachment = useCallback(async () => {
    const result = await window.electronAPI.openFileDialog() as {
      dataUri: string; mimeType: string; type: 'image' | 'audio' | 'file'
      name: string; sizeBytes: number
    } | { error: string } | null
    if (!result) return
    if ('error' in result) { alert(result.error); return }
    await handleSendMedia(result.dataUri, result.type, result.mimeType, result.name, result.sizeBytes)
  }, [handleSendMedia])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(true)
  }, [])

  const handleDragLeave = useCallback(() => setDragOver(false), [])

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const file = e.dataTransfer.files[0]
    if (!file) return
    if (file.size > 5 * 1024 * 1024) { alert('File terlalu besar (maks 5 MB)'); return }
    const buf = await file.arrayBuffer()
    const bytes = new Uint8Array(buf)
    let binary = ''
    bytes.forEach((b) => { binary += String.fromCharCode(b) })
    const base64 = btoa(binary)
    const mimeType = file.type || 'application/octet-stream'
    const dataUri = `data:${mimeType};base64,${base64}`
    const type: 'image' | 'audio' | 'file' = mimeType.startsWith('image/')
      ? 'image' : mimeType.startsWith('audio/') ? 'audio' : 'file'
    await handleSendMedia(dataUri, type, mimeType, file.name, file.size)
  }, [handleSendMedia])

  const handleSend = useCallback(async () => {
    const content = text.trim()
    if (!content || !identity) return
    setText('')
    const currentReply = replyTo
    setReplyTo(null)

    const now = Date.now()
    const messageId = `${identity.userId}-${now}-${Math.random().toString(36).slice(2, 8)}`

    const newMsg: Message = {
      id: messageId,
      conversationId,
      senderId: identity.userId,
      type: 'text',
      content,
      status: 'pending',
      createdAt: now,
      isDeleted: false,
      replyToId: currentReply?.id ?? null,
    }
    setMessages((prev) => [...prev, newMsg])
    setTimeout(() => bottomRef.current?.scrollIntoView(), 50)

    await window.electronAPI.saveMessage({
      id: messageId,
      conversationId,
      senderId: identity.userId,
      type: 'text',
      content,
      status: 'pending',
      createdAt: now,
      replyToId: currentReply?.id ?? null,
    })

    const wireMessage = {
      id: messageId,
      type: 'text' as const,
      senderId: identity.userId,
      conversationId,
      content,
      timestamp: now,
      replyToId: currentReply?.id,
    }

    const result = await window.electronAPI.sendMessage({
      targetUserId: conversationId,
      message: wireMessage,
    }) as { status?: string }

    const finalStatus = result?.status === 'delivered' ? 'delivered'
      : result?.status === 'sent' ? 'sent'
      : result?.status === 'pending' ? 'pending'
      : 'failed'

    setMessages((prev) =>
      prev.map((m) => (m.id === messageId ? { ...m, status: finalStatus } : m)),
    )
    await window.electronAPI.updateMessageStatus({ messageId, status: finalStatus })
  }, [text, identity, conversationId, replyTo])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
    if (e.key === 'Escape') setReplyTo(null)
  }

  const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value)
    window.electronAPI.sendTyping({ targetUserId: conversationId, isTyping: true })
    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current)
    typingTimeoutRef.current = setTimeout(() => {
      window.electronAPI.sendTyping({ targetUserId: conversationId, isTyping: false })
    }, 2000)
  }

  const statusIcon: Record<string, string> = {
    pending: '⏳', sent: '✓', delivered: '✓✓', read: '✓✓', failed: '✗',
  }

  // Build a quick lookup map for quoting
  const msgMap = new Map(messages.map((m) => [m.id, m]))

  return (
    <div style={styles.container}>
      {/* Header */}
      <div style={styles.header}>
        <button style={styles.backBtn} onClick={onBack}>←</button>
        <div style={styles.avatar}>
          <span style={styles.avatarLetter}>{contactName.charAt(0).toUpperCase()}</span>
        </div>
        <div style={styles.headerInfo}>
          <span style={styles.contactName}>{contactName}</span>
          <span style={{
            ...styles.modeTag,
            color: contactOnline ? '#25D366' : connectionMode === 'internet' ? '#FFA500' : '#999',
          }}>
            {contactOnline ? 'Online' : connectionMode}
          </span>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          {onStartAudioCall && (
            <button
              title="Panggilan Suara"
              style={styles.callBtn}
              onClick={() => onStartAudioCall(crypto.randomUUID())}
            >
              📞
            </button>
          )}
          {onStartVideoCall && (
            <button
              title="Panggilan Video"
              style={styles.callBtn}
              onClick={() => onStartVideoCall(crypto.randomUUID())}
            >
              📹
            </button>
          )}
        </div>
      </div>

      {/* Offline banner */}
      {connectionMode === 'offline' && (
        <div style={styles.offlineBanner}>
          ⏳ Offline — pesan tersimpan & akan dikirim saat ada koneksi
        </div>
      )}

      {/* Messages */}
      <div
        style={{
          ...styles.messages,
          outline: dragOver ? '3px dashed #25D366' : 'none',
          outlineOffset: '-4px',
        }}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {/* Load more button */}
        {hasMore && (
          <div style={styles.loadMoreRow}>
            <button
              style={{ ...styles.loadMoreBtn, opacity: loadingMore ? 0.5 : 1 }}
              onClick={loadOlderMessages}
              disabled={loadingMore}
            >
              {loadingMore ? 'Memuat...' : '↑ Muat lebih banyak'}
            </button>
          </div>
        )}

        {messages.map((msg) => {
          const isOwn = msg.senderId === identity?.userId
          const quotedMsg = msg.replyToId ? msgMap.get(msg.replyToId) : null
          const isHovered = hoveredId === msg.id

          return (
            <div
              key={msg.id}
              style={{ ...styles.bubbleWrap, justifyContent: isOwn ? 'flex-end' : 'flex-start' }}
              onMouseEnter={() => setHoveredId(msg.id)}
              onMouseLeave={() => setHoveredId(null)}
            >
              {/* Delete button for own non-deleted messages */}
              {isOwn && !msg.isDeleted && isHovered && (
                <button
                  style={styles.deleteBtn}
                  onClick={() => handleDelete(msg.id)}
                  title="Hapus pesan"
                >
                  🗑
                </button>
              )}

              {/* Reply button for any non-deleted message */}
              {!msg.isDeleted && isHovered && (
                <button
                  style={{ ...styles.replyBubbleBtn, order: isOwn ? -1 : 1 }}
                  onClick={() => setReplyTo(msg)}
                  title="Balas"
                >
                  ↩
                </button>
              )}

              <div style={{ ...styles.bubble, ...(isOwn ? styles.bubbleOwn : styles.bubbleOther) }}>
                {/* Quote bar */}
                {quotedMsg && !msg.isDeleted && (
                  <div style={styles.quoteBar}>
                    <span style={styles.quoteText}>
                      {quotedMsg.isDeleted
                        ? 'Pesan dihapus'
                        : (quotedMsg.content?.slice(0, 60) ?? '')}
                    </span>
                  </div>
                )}

                {msg.isDeleted ? (
                  <span style={styles.deletedText}>Pesan dihapus</span>
                ) : msg.type === 'image' ? (
                  <img
                    src={msg.content ?? ''}
                    alt="attachment"
                    style={{ maxWidth: 280, maxHeight: 220, borderRadius: 8, display: 'block' }}
                    onError={(e) => { e.currentTarget.style.display = 'none' }}
                  />
                ) : msg.type === 'audio' ? (
                  <audio controls src={msg.content ?? ''} style={{ width: 250 }} />
                ) : msg.type === 'file' ? (
                  (() => {
                    let name = 'Attachment'; let size = 0; let uri = ''
                    try { const m = JSON.parse(msg.content ?? '{}') as { uri: string; name: string; size: number }; uri = m.uri; name = m.name; size = m.size } catch {}
                    return (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontSize: 28 }}>📎</span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontWeight: 600, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 180 }}>{name}</div>
                          {size > 0 && <div style={{ fontSize: 11, color: '#666' }}>{formatBytes(size)}</div>}
                        </div>
                        {uri && (
                          <a href={uri} download={name} style={{ fontSize: 20, textDecoration: 'none', color: '#075E54' }} title="Download">⬇</a>
                        )}
                      </div>
                    )
                  })()
                ) : (
                  <span style={styles.bubbleText}>{msg.content}</span>
                )}
                <div style={styles.bubbleMeta}>
                  <span style={styles.timeText}>{formatTime(msg.createdAt)}</span>
                  {isOwn && (
                    <span style={{
                      ...styles.statusIcon,
                      color: msg.status === 'read' ? '#34B7F1' : msg.status === 'failed' ? '#e53e3e' : '#666',
                    }}>
                      {statusIcon[msg.status] ?? ''}
                    </span>
                  )}
                </div>
              </div>
            </div>
          )
        })}
        <div ref={bottomRef} />
      </div>

      {/* Typing indicator */}
      {isContactTyping && (
        <div style={styles.typingBar}>
          <span style={styles.typingText}>{contactName} sedang mengetik...</span>
        </div>
      )}

      {/* Reply bar */}
      {replyTo && (
        <div style={styles.replyBar}>
          <div style={styles.replyBarContent}>
            <span style={styles.replyBarLabel}>Membalas:</span>
            <span style={styles.replyBarText}>
              {replyTo.content?.slice(0, 60) ?? ''}
            </span>
          </div>
          <button style={styles.replyBarClose} onClick={() => setReplyTo(null)}>✕</button>
        </div>
      )}

      {/* Input */}
      <div style={styles.inputBar}>
        <button
          style={styles.attachBtn}
          onClick={handleAttachment}
          title="Lampirkan file (maks 5 MB)"
        >
          📎
        </button>
        <textarea
          style={styles.input}
          placeholder="Tulis pesan..."
          value={text}
          onChange={handleTextChange}
          onKeyDown={handleKeyDown}
          rows={1}
          maxLength={4000}
        />
        <button
          style={{ ...styles.sendBtn, opacity: !text.trim() ? 0.4 : 1 }}
          onClick={handleSend}
          disabled={!text.trim()}
        >
          ➤
        </button>
      </div>
    </div>
  )
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const styles: Record<string, React.CSSProperties> = {
  container: { display: 'flex', flexDirection: 'column', height: '100vh', backgroundColor: '#ECE5DD' },
  header: {
    display: 'flex',
    alignItems: 'center',
    backgroundColor: '#075E54',
    padding: '10px 16px',
    gap: 12,
    WebkitAppRegion: 'drag',
  },
  backBtn: {
    background: 'none',
    border: 'none',
    color: '#fff',
    fontSize: 20,
    cursor: 'pointer',
    padding: '4px 8px',
    WebkitAppRegion: 'no-drag',
  },
  callBtn: {
    background: 'none',
    border: 'none',
    fontSize: 20,
    cursor: 'pointer',
    padding: '4px 6px',
    WebkitAppRegion: 'no-drag',
  },
  avatar: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: 'rgba(255,255,255,0.2)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarLetter: { color: '#fff', fontSize: 16, fontWeight: 600 },
  headerInfo: { display: 'flex', flexDirection: 'column' },
  contactName: { color: '#fff', fontWeight: 600, fontSize: 16 },
  modeTag: { fontSize: 11, fontWeight: 500 },
  offlineBanner: {
    backgroundColor: '#FFF3CD',
    padding: '6px 16px',
    fontSize: 12,
    color: '#856404',
    textAlign: 'center',
    borderBottom: '1px solid #FFEAA7',
  },
  messages: { flex: 1, overflowY: 'auto', padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 4 },
  bubbleWrap: { display: 'flex', width: '100%' },
  bubble: { maxWidth: '70%', borderRadius: 12, padding: '8px 12px' },
  bubbleOwn: { backgroundColor: '#DCF8C6', borderBottomRightRadius: 2 },
  bubbleOther: { backgroundColor: '#fff', borderBottomLeftRadius: 2 },
  bubbleText: { fontSize: 15, color: '#111', lineHeight: 1.5 },
  deletedText: { fontSize: 13, color: '#999', fontStyle: 'italic' },
  bubbleMeta: { display: 'flex', justifyContent: 'flex-end', gap: 4, marginTop: 4 },
  timeText: { fontSize: 11, color: '#666' },
  statusIcon: { fontSize: 11 },
  typingBar: {
    padding: '4px 16px',
    backgroundColor: '#f5f5f5',
    borderTop: '1px solid #eee',
  },
  typingText: {
    fontSize: 12,
    color: '#075E54',
    fontStyle: 'italic',
  },
  loadMoreRow: { display: 'flex', justifyContent: 'center', padding: '8px 0' },
  loadMoreBtn: {
    padding: '6px 16px',
    backgroundColor: 'rgba(7,94,84,0.08)',
    border: 'none',
    borderRadius: 16,
    fontSize: 12,
    color: '#075E54',
    cursor: 'pointer',
  },
  replyBubbleBtn: {
    background: 'none',
    border: 'none',
    fontSize: 16,
    cursor: 'pointer',
    color: '#555',
    padding: '0 4px',
    alignSelf: 'center',
    flexShrink: 0,
  },
  deleteBtn: {
    background: 'none',
    border: 'none',
    fontSize: 14,
    cursor: 'pointer',
    color: '#e53e3e',
    padding: '0 4px',
    alignSelf: 'flex-start',
    flexShrink: 0,
  },
  quoteBar: {
    backgroundColor: 'rgba(0,0,0,0.06)',
    borderLeft: '3px solid #075E54',
    borderRadius: 6,
    padding: '4px 8px',
    marginBottom: 6,
    maxWidth: 280,
  },
  quoteText: { fontSize: 12, color: '#555', display: 'block', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  replyBar: {
    display: 'flex',
    alignItems: 'center',
    padding: '6px 12px',
    backgroundColor: '#fff',
    borderTop: '1px solid #e0e0e0',
    gap: 8,
  },
  replyBarContent: { flex: 1, display: 'flex', flexDirection: 'column', gap: 2 },
  replyBarLabel: { fontSize: 11, fontWeight: 700, color: '#075E54' },
  replyBarText: { fontSize: 13, color: '#444', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  replyBarClose: {
    background: 'none',
    border: 'none',
    fontSize: 16,
    cursor: 'pointer',
    color: '#999',
    padding: '0 4px',
  },
  inputBar: {
    display: 'flex',
    alignItems: 'flex-end',
    padding: '8px 12px',
    backgroundColor: '#f5f5f5',
    borderTop: '1px solid #ddd',
    gap: 8,
  },
  input: {
    flex: 1,
    padding: '10px 14px',
    borderRadius: 20,
    border: '1px solid #ddd',
    fontSize: 15,
    resize: 'none',
    outline: 'none',
    fontFamily: 'inherit',
    lineHeight: 1.5,
    maxHeight: 120,
  },
  sendBtn: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: '#25D366',
    border: 'none',
    color: '#fff',
    fontSize: 18,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  attachBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: 'transparent',
    border: '1px solid #ccc',
    fontSize: 18,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
}
