import React, { useState } from 'react'
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Alert,
  ActivityIndicator,
} from 'react-native'
import { useAppStore } from '../stores/useAppStore'
import { getDatabase } from '../db'
import { identity as identityTable, prekeys as prekeysTable } from '@im/db-schema'
import { v4 as uuidv4 } from 'uuid'
import {
  generateIdentityKeyPair,
  generateDHKeyPair,
  identityToDHKeyPair,
  signBytes,
} from '@im/crypto'

/**
 * Layar setup pertama kali — dibuka saat user belum punya identitas lokal.
 * Membuat keypair Ed25519 + prekeys Signal Protocol dan menyimpan ke SQLite.
 */
export function SetupScreen() {
  const { setIdentity } = useAppStore()
  const [displayName, setDisplayName] = useState('')
  const [relayUrl, setRelayUrl] = useState('wss://your-relay.up.railway.app')
  const [loading, setLoading] = useState(false)

  const handleSetup = async () => {
    const name = displayName.trim()
    if (!name || name.length < 2) {
      Alert.alert('Nama terlalu pendek', 'Masukkan nama minimal 2 karakter.')
      return
    }

    setLoading(true)
    try {
      const db = getDatabase()
      const userId = uuidv4()
      const deviceId = uuidv4()
      const now = Date.now()

      // 1. Generate Ed25519 identity keypair
      const identityKP = generateIdentityKeyPair()

      // 2. Generate signed prekey (X25519, ditandatangani dengan identity key)
      const spk = generateDHKeyPair()
      const spkId = Math.floor(Math.random() * 0xffffff)
      const spkSignature = signBytes(identityKP.privateKey, spk.publicKey)

      // 3. Generate 10 one-time prekeys (X25519)
      const oneTimePreKeys = Array.from({ length: 10 }, (_, i) => ({
        ...generateDHKeyPair(),
        id: spkId * 100 + i,
      }))

      // 4. Simpan identity ke SQLite
      await db.insert(identityTable).values({
        userId,
        displayName: name,
        privateKey: identityKP.privateKey,
        publicKey: identityKP.publicKey,
        deviceId,
        createdAt: now,
      })

      // 5. Simpan signed prekey
      await db.insert(prekeysTable).values({
        id: spkId,
        keyType: 'signed_prekey',
        privateKey: spk.privateKey,
        publicKey: spk.publicKey,
        signature: spkSignature,
        createdAt: now,
      })

      // 6. Simpan semua one-time prekeys
      for (const opk of oneTimePreKeys) {
        await db.insert(prekeysTable).values({
          id: opk.id,
          keyType: 'one_time_prekey',
          privateKey: opk.privateKey,
          publicKey: opk.publicKey,
          createdAt: now,
        })
      }

      // 7. Simpan ke store (X25519 identity key untuk bundle)
      const dhKeyPair = identityToDHKeyPair(identityKP)
      setIdentity({
        userId,
        displayName: name,
        deviceId,
        publicKey: Buffer.from(identityKP.publicKey).toString('base64'),
        relayUrl,
      })
    } catch (err) {
      Alert.alert('Error', 'Gagal membuat identitas. Coba lagi.')
      console.error(err)
    } finally {
      setLoading(false)
    }
  }

  return (
    <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
      <View style={styles.card}>
        <Text style={styles.logo}>💬</Text>
        <Text style={styles.title}>Selamat Datang</Text>
        <Text style={styles.subtitle}>
          Identitas Anda dibuat secara lokal di device ini.{'\n'}
          Tidak ada akun yang dibuat di server.
        </Text>

        <Text style={styles.label}>Nama Tampilan</Text>
        <TextInput
          style={styles.input}
          placeholder="Masukkan nama Anda"
          placeholderTextColor="#999"
          value={displayName}
          onChangeText={setDisplayName}
          maxLength={50}
          autoCapitalize="words"
        />

        <Text style={styles.label}>Relay Server URL</Text>
        <TextInput
          style={styles.input}
          placeholder="wss://your-relay.up.railway.app"
          placeholderTextColor="#999"
          value={relayUrl}
          onChangeText={setRelayUrl}
          autoCapitalize="none"
          keyboardType="url"
        />
        <Text style={styles.hint}>
          URL WebSocket relay server Anda. Biarkan default jika menggunakan Railway.
        </Text>

        <TouchableOpacity
          style={[styles.button, loading && styles.buttonDisabled]}
          onPress={handleSetup}
          disabled={loading || !displayName.trim()}
        >
          {loading ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.buttonText}>Mulai</Text>
          )}
        </TouchableOpacity>

        <Text style={styles.privacyNote}>
          🔒 Semua data tersimpan lokal di device Anda.{'\n'}
          Server tidak menyimpan pesan Anda.
        </Text>
      </View>
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  container: {
    flexGrow: 1,
    backgroundColor: '#075E54',
    justifyContent: 'center',
    padding: 24,
  },
  card: {
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 24,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 8,
    elevation: 4,
  },
  logo: { fontSize: 56, textAlign: 'center', marginBottom: 12 },
  title: { fontSize: 26, fontWeight: '700', color: '#111', textAlign: 'center', marginBottom: 8 },
  subtitle: { fontSize: 14, color: '#666', textAlign: 'center', lineHeight: 20, marginBottom: 24 },
  label: { fontSize: 13, fontWeight: '600', color: '#333', marginBottom: 6 },
  input: {
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    color: '#111',
    marginBottom: 8,
  },
  hint: { fontSize: 12, color: '#999', marginBottom: 20 },
  button: {
    backgroundColor: '#25D366',
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 8,
  },
  buttonDisabled: { backgroundColor: '#ccc' },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  privacyNote: {
    marginTop: 20,
    fontSize: 12,
    color: '#999',
    textAlign: 'center',
    lineHeight: 18,
  },
})
