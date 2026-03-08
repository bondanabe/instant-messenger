/**
 * CallScreen (Desktop/Electron) — WebRTC 1-on-1 audio/video call.
 * Uses Chromium's native RTCPeerConnection (no extra library needed).
 * Signaling via window.electronAPI.sendCallSignal / onCallSignal (IPC bridge).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { CallSignalPayload, CallType, CallIceCandidate } from '@im/core'

interface Props {
  callId: string
  contactUserId: string
  contactName: string
  callType: CallType
  isIncoming: boolean
  /** SDP offer from caller — only present when isIncoming=true */
  sdpOffer?: string
  onEnd: () => void
}

type CallState = 'ringing' | 'connecting' | 'connected' | 'ended'

const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }]

// Chromium's RTCPeerConnection is available globally in Electron renderer
const WebRTCPeerConnection =
  (window as unknown as { RTCPeerConnection: typeof RTCPeerConnection }).RTCPeerConnection

export function CallScreen({
  callId,
  contactUserId,
  contactName,
  callType,
  isIncoming,
  sdpOffer,
  onEnd,
}: Props) {
  const [callState, setCallState] = useState<CallState>(isIncoming ? 'ringing' : 'connecting')
  const [isMuted, setIsMuted] = useState(false)
  const [isCameraOff, setIsCameraOff] = useState(false)
  const [callDuration, setCallDuration] = useState(0)

  const localVideoRef = useRef<HTMLVideoElement>(null)
  const remoteVideoRef = useRef<HTMLVideoElement>(null)
  const pcRef = useRef<RTCPeerConnection | null>(null)
  const localStreamRef = useRef<MediaStream | null>(null)
  const pendingCandidatesRef = useRef<RTCIceCandidateInit[]>([])
  const remoteDescSetRef = useRef(false)
  const hangupSentRef = useRef(false)
  const durationTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const unsubRef = useRef<(() => void) | null>(null)

  // ── helpers ──────────────────────────────────────────────────

  const sendSignal = useCallback(
    (partial: Omit<CallSignalPayload, 'fromUserId' | 'callId' | 'toUserId'>) => {
      window.electronAPI.sendCallSignal({
        callId,
        toUserId: contactUserId,
        type: partial.type,
        ...(partial.callType !== undefined && { callType: partial.callType }),
        ...(partial.sdp !== undefined && { sdp: partial.sdp }),
        ...(partial.candidate !== undefined && { candidate: partial.candidate }),
      })
    },
    [callId, contactUserId],
  )

  const doHangUp = useCallback(
    (sendEnd: boolean) => {
      if (hangupSentRef.current) return
      hangupSentRef.current = true
      if (sendEnd) sendSignal({ type: 'end' })
      localStreamRef.current?.getTracks().forEach((t) => t.stop())
      pcRef.current?.close()
      unsubRef.current?.()
      if (durationTimerRef.current) clearInterval(durationTimerRef.current)
      setCallState('ended')
      setTimeout(onEnd, 800)
    },
    [onEnd, sendSignal],
  )

  const drainPendingCandidates = useCallback(async () => {
    const pc = pcRef.current
    if (!pc) return
    for (const cand of pendingCandidatesRef.current) {
      await pc.addIceCandidate(new RTCIceCandidate(cand)).catch(() => {})
    }
    pendingCandidatesRef.current = []
  }, [])

  // ── PeerConnection ────────────────────────────────────────────

  const initPC = useCallback(() => {
    const pc = new WebRTCPeerConnection({ iceServers: ICE_SERVERS })
    pcRef.current = pc

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        sendSignal({
          type: 'ice-candidate',
          candidate: {
            candidate: event.candidate.candidate,
            sdpMid: event.candidate.sdpMid,
            sdpMLineIndex: event.candidate.sdpMLineIndex,
          } as CallIceCandidate,
        })
      }
    }

    pc.ontrack = (event) => {
      const [remoteStream] = event.streams
      if (remoteStream && remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = remoteStream
      }
    }

    return pc
  }, [sendSignal])

  // ── Caller flow ───────────────────────────────────────────────

  const startCall = useCallback(async () => {
    const pc = initPC()
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: callType === 'video',
    })
    localStreamRef.current = stream
    if (localVideoRef.current) localVideoRef.current.srcObject = stream
    stream.getTracks().forEach((t) => pc.addTrack(t, stream))

    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    sendSignal({ type: 'offer', callType, sdp: offer.sdp ?? '' })
    setCallState('connecting')
  }, [callType, initPC, sendSignal])

  // ── Callee flow ───────────────────────────────────────────────

  const acceptCall = useCallback(async () => {
    setCallState('connecting')
    const pc = initPC()
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: callType === 'video',
    })
    localStreamRef.current = stream
    if (localVideoRef.current) localVideoRef.current.srcObject = stream
    stream.getTracks().forEach((t) => pc.addTrack(t, stream))

    await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: sdpOffer ?? '' }))
    remoteDescSetRef.current = true
    await drainPendingCandidates()

    const answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)
    sendSignal({ type: 'answer', sdp: answer.sdp ?? '' })
  }, [callType, drainPendingCandidates, initPC, sdpOffer, sendSignal])

  // ── Subscribe to incoming signals ─────────────────────────────

  useEffect(() => {
    const unsub = window.electronAPI.onCallSignal(async (raw: unknown) => {
      const payload = raw as CallSignalPayload
      if (payload.callId !== callId) return

      if (payload.type === 'answer') {
        const pc = pcRef.current
        if (!pc) return
        await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: payload.sdp ?? '' }))
        remoteDescSetRef.current = true
        await drainPendingCandidates()
        setCallState('connected')
        durationTimerRef.current = setInterval(() => setCallDuration((d) => d + 1), 1000)
      } else if (payload.type === 'ice-candidate' && payload.candidate) {
        const cand: RTCIceCandidateInit = {
          candidate: payload.candidate.candidate,
          sdpMid: payload.candidate.sdpMid ?? null,
          sdpMLineIndex: payload.candidate.sdpMLineIndex ?? null,
        }
        if (remoteDescSetRef.current) {
          await pcRef.current?.addIceCandidate(new RTCIceCandidate(cand)).catch(() => {})
        } else {
          pendingCandidatesRef.current.push(cand)
        }
      } else if (payload.type === 'reject' || payload.type === 'end') {
        doHangUp(false)
      }
    })
    unsubRef.current = unsub
    return unsub
  }, [callId, doHangUp, drainPendingCandidates])

  // ── Auto-start (caller) ───────────────────────────────────────

  useEffect(() => {
    if (!isIncoming) startCall().catch(console.warn)
    return () => {
      if (!hangupSentRef.current) {
        localStreamRef.current?.getTracks().forEach((t) => t.stop())
        pcRef.current?.close()
        if (durationTimerRef.current) clearInterval(durationTimerRef.current)
        unsubRef.current?.()
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Connected state → start timer for caller ─────────────────

  useEffect(() => {
    if (callState === 'connected' && !durationTimerRef.current) {
      durationTimerRef.current = setInterval(() => setCallDuration((d) => d + 1), 1000)
    }
  }, [callState])

  // ── Duration formatter ────────────────────────────────────────

  const formatDuration = (secs: number) => {
    const m = Math.floor(secs / 60)
    const s = secs % 60
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  }

  // ── Toggle controls ───────────────────────────────────────────

  const toggleMute = () => {
    localStreamRef.current?.getAudioTracks().forEach((t) => {
      t.enabled = !t.enabled
    })
    setIsMuted((m) => !m)
  }

  const toggleCamera = () => {
    localStreamRef.current?.getVideoTracks().forEach((t) => {
      t.enabled = !t.enabled
    })
    setIsCameraOff((c) => !c)
  }

  // ── Render ────────────────────────────────────────────────────

  return (
    <div style={styles.container}>
      {/* Remote video / avatar */}
      {callType === 'video' ? (
        <video ref={remoteVideoRef} autoPlay style={styles.remoteVideo as React.CSSProperties} />
      ) : (
        <div style={styles.avatarArea as React.CSSProperties}>
          <div style={styles.avatar as React.CSSProperties}>
            <span style={styles.avatarLetter as React.CSSProperties}>{contactName[0]?.toUpperCase() ?? '?'}</span>
          </div>
          <div style={styles.contactName as React.CSSProperties}>{contactName}</div>
          <div style={styles.callStatus as React.CSSProperties}>
            {callState === 'ringing' && '📞 Panggilan masuk...'}
            {callState === 'connecting' && '⏳ Menghubungkan...'}
            {callState === 'connected' && formatDuration(callDuration)}
            {callState === 'ended' && 'Panggilan selesai'}
          </div>
        </div>
      )}

      {/* Local video preview */}
      {callType === 'video' && (
        <video
          ref={localVideoRef}
          autoPlay
          muted
          style={styles.localVideo as React.CSSProperties}
        />
      )}

      {/* Duration overlay for video */}
      {callType === 'video' && callState === 'connected' && (
        <div style={styles.durationOverlay as React.CSSProperties}>{formatDuration(callDuration)}</div>
      )}

      {/* Incoming call — accept/reject */}
      {isIncoming && callState === 'ringing' && (
        <div style={styles.incomingRow as React.CSSProperties}>
          <button
            style={{ ...styles.controlBtn, ...styles.rejectBtn } as React.CSSProperties}
            onClick={() => { sendSignal({ type: 'reject' }); doHangUp(false) }}
          >
            ✕
          </button>
          <button
            style={{ ...styles.controlBtn, ...styles.acceptBtn } as React.CSSProperties}
            onClick={acceptCall}
          >
            📞
          </button>
        </div>
      )}

      {/* In-call controls */}
      {callState !== 'ringing' && callState !== 'ended' && (
        <div style={styles.controlsRow as React.CSSProperties}>
          <button
            style={{ ...styles.controlBtn, ...(isMuted ? styles.controlBtnActive : {}) } as React.CSSProperties}
            onClick={toggleMute}
            title={isMuted ? 'Unmute' : 'Mute'}
          >
            {isMuted ? '🔇' : '🎙️'}
          </button>
          {callType === 'video' && (
            <button
              style={{ ...styles.controlBtn, ...(isCameraOff ? styles.controlBtnActive : {}) } as React.CSSProperties}
              onClick={toggleCamera}
              title={isCameraOff ? 'Aktifkan Kamera' : 'Matikan Kamera'}
            >
              {isCameraOff ? '🚫' : '📷'}
            </button>
          )}
          <button
            style={{ ...styles.controlBtn, ...styles.hangUpBtn } as React.CSSProperties}
            onClick={() => doHangUp(true)}
            title="Akhiri Panggilan"
          >
            📵
          </button>
        </div>
      )}
    </div>
  )
}

// Inline styles (no CSS file to keep things self-contained)
const styles = {
  container: {
    display: 'flex',
    flexDirection: 'column' as const,
    width: '100%',
    height: '100%',
    background: '#1a1a2e',
    position: 'relative' as const,
    userSelect: 'none' as const,
  },
  remoteVideo: { flex: 1, width: '100%', height: '100%', objectFit: 'cover' as const, background: '#000' },
  avatarArea: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column' as const,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 16,
  },
  avatar: {
    width: 100,
    height: 100,
    borderRadius: '50%',
    background: '#128C7E',
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
  },
  avatarLetter: { fontSize: 44, color: '#fff', fontWeight: '700' },
  contactName: { fontSize: 24, color: '#fff', fontWeight: '600' },
  callStatus: { fontSize: 16, color: '#ccc' },
  localVideo: {
    position: 'absolute' as const,
    top: 20,
    right: 16,
    width: 140,
    height: 100,
    borderRadius: 8,
    border: '2px solid #fff',
    objectFit: 'cover' as const,
    background: '#000',
    zIndex: 10,
  },
  durationOverlay: {
    position: 'absolute' as const,
    top: 20,
    left: 16,
    background: 'rgba(0,0,0,0.5)',
    borderRadius: 6,
    padding: '4px 10px',
    color: '#fff',
    fontSize: 14,
    zIndex: 10,
  },
  incomingRow: {
    display: 'flex',
    flexDirection: 'row' as const,
    justifyContent: 'center',
    gap: 60,
    padding: '20px 0 32px',
  },
  controlsRow: {
    display: 'flex',
    flexDirection: 'row' as const,
    justifyContent: 'center',
    gap: 24,
    padding: '20px 0 32px',
  },
  controlBtn: {
    width: 60,
    height: 60,
    borderRadius: '50%',
    border: 'none',
    background: 'rgba(255,255,255,0.15)',
    color: '#fff',
    fontSize: 22,
    cursor: 'pointer',
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
  },
  controlBtnActive: { background: 'rgba(255,255,255,0.35)' },
  hangUpBtn: { background: '#e53e3e' },
  acceptBtn: { background: '#25D366' },
  rejectBtn: { background: '#e53e3e' },
}
