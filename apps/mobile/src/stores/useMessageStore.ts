import { create } from 'zustand'
import { getDatabase } from '../db'
import { conversations, messages, contacts } from '@im/db-schema'
import { eq, desc } from 'drizzle-orm'
import type { WireMessage } from '@im/core'

export interface ConversationSummary {
  id: string
  type: 'dm' | 'group'
  name: string
  avatarData?: Uint8Array | null
  lastMsgPreview?: string | null
  lastMsgAt?: number | null
  unreadCount: number
  isArchived: boolean
}

export interface Message {
  id: string
  conversationId: string
  senderId: string
  type: string
  content: string | null
  status: string
  createdAt: number
  receivedAt?: number | null
  replyToId?: string | null
  isDeleted: boolean
}

interface MessageStore {
  conversations: ConversationSummary[]
  activeConversationId: string | null
  messages: Record<string, Message[]>  // key: conversationId

  // Actions
  loadConversations: () => Promise<void>
  loadMessages: (conversationId: string) => Promise<void>
  setActiveConversation: (id: string | null) => void
  receiveMessage: (msg: WireMessage) => Promise<void>
  updateMessageStatus: (messageId: string, status: Message['status']) => Promise<void>
  markConversationRead: (conversationId: string) => Promise<void>
}

export const useMessageStore = create<MessageStore>((set, get) => ({
  conversations: [],
  activeConversationId: null,
  messages: {},

  loadConversations: async () => {
    const db = getDatabase()
    const rows = await db
      .select()
      .from(conversations)
      .orderBy(desc(conversations.lastMsgAt))

    set({
      conversations: rows.map((r) => ({
        id: r.id,
        type: r.type,
        name: r.name ?? '',
        avatarData: r.avatarData,
        lastMsgPreview: r.lastMsgPreview,
        lastMsgAt: r.lastMsgAt,
        unreadCount: r.unreadCount,
        isArchived: r.isArchived,
      })),
    })
  },

  loadMessages: async (conversationId) => {
    const db = getDatabase()
    const rows = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(desc(messages.createdAt))
      .limit(50)

    set((state) => ({
      messages: {
        ...state.messages,
        [conversationId]: rows.map((r) => ({
          id: r.id,
          conversationId: r.conversationId,
          senderId: r.senderId,
          type: r.type,
          content: r.content,
          status: r.status,
          createdAt: r.createdAt,
          receivedAt: r.receivedAt,
          replyToId: r.replyToId,
          isDeleted: r.isDeleted,
        })),
      },
    }))
  },

  setActiveConversation: (id) => set({ activeConversationId: id }),

  receiveMessage: async (msg) => {
    const db = getDatabase()
    const now = Date.now()

    // Pastikan conversation ada
    const existing = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.id, msg.conversationId))

    if (existing.length === 0) {
      await db.insert(conversations).values({
        id: msg.conversationId,
        type: 'dm',
        lastMsgAt: now,
        lastMsgPreview: msg.content?.slice(0, 80) ?? '',
        unreadCount: 1,
        createdAt: now,
      })
    } else {
      await db
        .update(conversations)
        .set({
          lastMsgAt: now,
          lastMsgPreview: msg.content?.slice(0, 80) ?? '',
          unreadCount: (existing[0] ? 0 : 0), // akan di-increment di bawah
        })
        .where(eq(conversations.id, msg.conversationId))
    }

    // Simpan pesan
    await db.insert(messages).values({
      id: msg.id,
      conversationId: msg.conversationId,
      senderId: msg.senderId,
      type: msg.type,
      content: msg.content,
      status: 'delivered',
      replyToId: msg.replyToId ?? null,
      createdAt: msg.createdAt,
      receivedAt: now,
    })

    // Update store
    await get().loadConversations()
    if (get().activeConversationId === msg.conversationId) {
      await get().loadMessages(msg.conversationId)
    }
  },

  updateMessageStatus: async (messageId, status) => {
    const db = getDatabase()
    await db.update(messages).set({ status }).where(eq(messages.id, messageId))

    // Update in-memory state
    set((state) => {
      const updated = { ...state.messages }
      for (const convId of Object.keys(updated)) {
        const msgs = updated[convId]
        if (!msgs) continue
        const idx = msgs.findIndex((m) => m.id === messageId)
        if (idx !== -1) {
          updated[convId] = msgs.map((m) =>
            m.id === messageId ? { ...m, status } : m,
          )
          break
        }
      }
      return { messages: updated }
    })
  },

  markConversationRead: async (conversationId) => {
    const db = getDatabase()
    await db
      .update(conversations)
      .set({ unreadCount: 0 })
      .where(eq(conversations.id, conversationId))
    await get().loadConversations()
  },
}))
