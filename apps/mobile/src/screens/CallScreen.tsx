/**
 * CallScreen — WebRTC 1-on-1 audio/video call (react-native-webrtc)
 *
 * Route params:
 *   callId        — UUID untuk sesi ini (dibuat oleh caller)
 *   contactUserId — userId lawan bicara
 *   contactName   — nama tampilan
 *   callType      — 'audio' | 'video'
 *   isIncoming    — true jika kita adalah callee
 *   sdpOffer      — SDP offer dari caller (hanya ada jika isIncoming=true)
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  StatusBar,
  Platform,
} from 'react-native'
import {
  RTCPeerConnection,
  RTCSessionDescription,
  RTCIceCandidate,
  mediaDevices,
  RTCView,
  type MediaStream,
} from 'react-native-webrtc'
import { useNavigation, useRoute } from '@react-navigation/native'
import type { NativeStackNavigationProp, NativeStackRouteProp } from '@react-navigation/native-stack'
import type { RootStackParamList } from '../../App'
import { useAppStore } from '../stores/useAppStore'
import { getConnectionManager } from '../services/cmSingleton'
import type { CallIceCandidate, CallSignalPayload } from '@im/core'

type Route = NativeStackRouteProp<RootStackParamList, 'Call'>
type Nav = NativeStackNavigationProp<RootStackParamList, 'Call'>

type CallState = 'ringing' | 'connecting' | 'connected' | 'ended'

const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }]

export function CallScreen() {
  const route = useRoute<Route>()
  const navigation = useNavigation<Nav>()
  const { callId, contactUserId, contactName, callType, isIncoming, sdpOffer } = route.params
  const { identity } = useAppStore()

  const [callState, setCallState] = useState<CallState>(isIncoming ? 'ringing' : 'connecting')
  const [localStream, setLocalStream] = useState<MediaStream | null>(null)
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null)
  const [isMuted, setIsMuted] = useState(false)
  const [isCameraOff, setIsCameraOff] = useState(false)
  const [callDuration, setCallDuration] = useState(0)

  const pcRef = useRef<RTCPeerConnection | null>(null)
  const pendingCandidatesRef = useRef<RTCIceCandidate[]>([])
  const remoteDescSetRef = useRef(false)
  const durationTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const hangupSentRef = useRef(false)

  // ── helpers ──────────────────────────────────────────────────

  const sendSignal = useCallback(
    (partial: Omit<CallSignalPayload, 'fromUserId' | 'callId' | 'toUserId'>) => {
      const cm = getConnectionManager()
      cm?.sendCallSignal({ callId, toUserId: contactUserId, ...partial })
    },
    [callId, contactUserId],
  )

  const doHangUp = useCallback(
    (sendEnd: boolean) => {
      if (hangupSentRef.current) return
      hangupSentRef.current = true
      if (sendEnd) sendSignal({ type: 'end' })
      localStream?.getTracks().forEach((t) => t.stop())
      pcRef.current?.close()
      if (durationTimerRef.current) clearInterval(durationTimerRef.current)
      setCallState('ended')
      setTimeout(() => navigation.goBack(), 1000)
    },
    [localStream, navigation, sendSignal],
  )

  const drainPendingCandidates = useCallback(async () => {
    const pc = pcRef.current
    if (!pc) return
    for (const cand of pendingCandidatesRef.current) {
      await pc.addIceCandidate(cand).catch(() => {})
    }
    pendingCandidatesRef.current = []
  }, [])

  // ── PeerConnection setup ──────────────────────────────────────

  const initPeerConnection = useCallback(() => {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })
    pcRef.current = pc

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        const c = event.candidate
        sendSignal({
          type: 'ice-candidate',
          candidate: {
            candidate: c.candidate,
            sdpMid: c.sdpMid ?? null,
            sdpMLineIndex: c.sdpMLineIndex ?? null,
          } as CallIceCandidate,
        })
      }
    }

    pc.ontrack = (event) => {
      const streams = event.streams
      if (streams?.[0]) setRemoteStream(streams[0] as unknown as MediaStream)
    }

    return pc
  }, [sendSignal])

  // ── Caller flow ───────────────────────────────────────────────

  const startCall = useCallback(async () => {
    const pc = initPeerConnection()

    const stream = await mediaDevices.getUserMedia({
      audio: true,
      video: callType === 'video',
    })
    setLocalStream(stream as unknown as MediaStream)
    stream.getTracks().forEach((track) => {
      pc.addTrack(track, stream)
    })

    const offer = await pc.createOffer({})
    await pc.setLocalDescription(offer)

    sendSignal({
      type: 'offer',
      callType,
      sdp: offer.sdp ?? '',
    })
    setCallState('connecting')
  }, [callType, initPeerConnection, sendSignal])

  // ── Callee flow ───────────────────────────────────────────────

  const acceptCall = useCallback(async () => {
    setCallState('connecting')
    const pc = initPeerConnection()

    const stream = await mediaDevices.getUserMedia({
      audio: true,
      video: callType === 'video',
    })
    setLocalStream(stream as unknown as MediaStream)
    stream.getTracks().forEach((track) => {
      pc.addTrack(track, stream)
    })

    // Set remote description from offer
    await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: sdpOffer ?? '' }))
    remoteDescSetRef.current = true
    await drainPendingCandidates()

    const answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)

    sendSignal({ type: 'answer', sdp: answer.sdp ?? '' })
  }, [callType, drainPendingCandidates, initPeerConnection, sdpOffer, sendSignal])

  // ── Incoming signal handler ───────────────────────────────────

  useEffect(() => {
    const cm = getConnectionManager()
    if (!cm) return

    const unsub = cm.onCallSignal(async (payload: CallSignalPayload) => {
      if (payload.callId !== callId) return

      if (payload.type === 'answer') {
        const pc = pcRef.current
        if (!pc) return
        await pc.setRemoteDescription(
          new RTCSessionDescription({ type: 'answer', sdp: payload.sdp ?? '' }),
        )
        remoteDescSetRef.current = true
        await drainPendingCandidates()
        setCallState('connected')
        durationTimerRef.current = setInterval(() => setCallDuration((d) => d + 1), 1000)
      } else if (payload.type === 'ice-candidate' && payload.candidate) {
        const cand = new RTCIceCandidate({
          candidate: payload.candidate.candidate,
          sdpMid: payload.candidate.sdpMid ?? undefined,
          sdpMLineIndex: payload.candidate.sdpMLineIndex ?? undefined,
        })
        if (remoteDescSetRef.current) {
          await pcRef.current?.addIceCandidate(cand).catch(() => {})
        } else {
          pendingCandidatesRef.current.push(cand)
        }
      } else if (payload.type === 'reject') {
        doHangUp(false)
      } else if (payload.type === 'end') {
        doHangUp(false)
      }
    })

    return unsub
  }, [callId, doHangUp, drainPendingCandidates])

  // ── Auto-start (caller) ───────────────────────────────────────

  useEffect(() => {
    if (!isIncoming) {
      startCall().catch(console.warn)
    }
    return () => {
      // Cleanup on unmount only if not already hung up
      if (!hangupSentRef.current) {
        localStream?.getTracks().forEach((t) => t.stop())
        pcRef.current?.close()
        if (durationTimerRef.current) clearInterval(durationTimerRef.current)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Connected state tracking for caller ──────────────────────

  useEffect(() => {
    if (callState === 'connected' && !durationTimerRef.current) {
      durationTimerRef.current = setInterval(() => setCallDuration((d) => d + 1), 1000)
    }
  }, [callState])

  // ── Toggle controls ───────────────────────────────────────────

  const toggleMute = () => {
    localStream?.getAudioTracks().forEach((t) => {
      t.enabled = !t.enabled
    })
    setIsMuted((m) => !m)
  }

  const toggleCamera = () => {
    localStream?.getVideoTracks().forEach((t) => {
      t.enabled = !t.enabled
    })
    setIsCameraOff((c) => !c)
  }

  // ── Duration formatter ────────────────────────────────────────

  const formatDuration = (secs: number) => {
    const m = Math.floor(secs / 60)
    const s = secs % 60
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  }

  // ── Render ────────────────────────────────────────────────────

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#000" />

      {/* Remote video or avatar */}
      {callType === 'video' && remoteStream ? (
        <RTCView
          streamURL={(remoteStream as unknown as { toURL: () => string }).toURL()}
          style={styles.remoteVideo}
          objectFit="cover"
        />
      ) : (
        <View style={styles.avatarArea}>
          <View style={styles.avatar}>
            <Text style={styles.avatarLetter}>{contactName[0]?.toUpperCase() ?? '?'}</Text>
          </View>
          <Text style={styles.contactName}>{contactName}</Text>
          <Text style={styles.callStatus}>
            {callState === 'ringing' && '📞 Panggilan masuk...'}
            {callState === 'connecting' && '⏳ Menghubungkan...'}
            {callState === 'connected' && formatDuration(callDuration)}
            {callState === 'ended' && 'Panggilan selesai'}
          </Text>
        </View>
      )}

      {/* Local video preview */}
      {callType === 'video' && localStream && (
        <RTCView
          streamURL={(localStream as unknown as { toURL: () => string }).toURL()}
          style={styles.localVideo}
          objectFit="cover"
          zOrder={1}
        />
      )}

      {/* Duration overlay for video calls */}
      {callType === 'video' && callState === 'connected' && (
        <View style={styles.durationOverlay}>
          <Text style={styles.durationText}>{formatDuration(callDuration)}</Text>
        </View>
      )}

      {/* Incoming call accept/reject */}
      {isIncoming && callState === 'ringing' && (
        <View style={styles.incomingRow}>
          <TouchableOpacity style={[styles.controlBtn, styles.rejectBtn]} onPress={() => {
            sendSignal({ type: 'reject' })
            doHangUp(false)
          }}>
            <Text style={styles.controlIcon}>✕</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.controlBtn, styles.acceptBtn]} onPress={acceptCall}>
            <Text style={styles.controlIcon}>📞</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* In-call controls */}
      {callState !== 'ringing' && callState !== 'ended' && (
        <View style={styles.controlsRow}>
          <TouchableOpacity style={[styles.controlBtn, isMuted && styles.controlBtnActive]} onPress={toggleMute}>
            <Text style={styles.controlIcon}>{isMuted ? '🔇' : '🎙️'}</Text>
          </TouchableOpacity>
          {callType === 'video' && (
            <TouchableOpacity style={[styles.controlBtn, isCameraOff && styles.controlBtnActive]} onPress={toggleCamera}>
              <Text style={styles.controlIcon}>{isCameraOff ? '🚫' : '📷'}</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity style={[styles.controlBtn, styles.hangUpBtn]} onPress={() => doHangUp(true)}>
            <Text style={styles.controlIcon}>📵</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#1a1a2e' },
  remoteVideo: { flex: 1 },
  avatarArea: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 16,
  },
  avatar: {
    width: 100,
    height: 100,
    borderRadius: 50,
    backgroundColor: '#128C7E',
    justifyContent: 'center',
    alignItems: 'center',
  },
  avatarLetter: { fontSize: 44, color: '#fff', fontWeight: '700' },
  contactName: { fontSize: 24, color: '#fff', fontWeight: '600' },
  callStatus: { fontSize: 16, color: '#ccc' },
  localVideo: {
    position: 'absolute',
    top: Platform.OS === 'ios' ? 60 : 40,
    right: 16,
    width: 100,
    height: 140,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: '#fff',
    zIndex: 10,
  },
  durationOverlay: {
    position: 'absolute',
    top: Platform.OS === 'ios' ? 60 : 40,
    left: 16,
    backgroundColor: 'rgba(0,0,0,0.5)',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  durationText: { color: '#fff', fontSize: 14 },
  incomingRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 60,
    paddingBottom: Platform.OS === 'ios' ? 48 : 32,
    paddingTop: 20,
  },
  controlsRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 24,
    paddingBottom: Platform.OS === 'ios' ? 48 : 32,
    paddingTop: 20,
  },
  controlBtn: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: 'rgba(255,255,255,0.15)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  controlBtnActive: { backgroundColor: 'rgba(255,255,255,0.35)' },
  hangUpBtn: { backgroundColor: '#e53e3e' },
  acceptBtn: { backgroundColor: '#25D366' },
  rejectBtn: { backgroundColor: '#e53e3e' },
  controlIcon: { fontSize: 24 },
})
