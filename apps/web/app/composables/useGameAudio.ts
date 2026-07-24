type OscillatorKind = OscillatorType

interface ToneOptions {
  type?: OscillatorKind
  volume?: number
  endFrequency?: number
}

const SOUND_PREFERENCE_KEY = 'swapduel:sound-enabled'

let audioContext: AudioContext | null = null
let masterGain: GainNode | null = null
let noiseBuffer: AudioBuffer | null = null
const lastPlayedAt = new Map<string, number>()

function ensureAudioGraph(): AudioContext | null {
  if (!import.meta.client) return null
  if (audioContext === null) {
    audioContext = new AudioContext()
    masterGain = audioContext.createGain()
    masterGain.gain.value = 0.24
    masterGain.connect(audioContext.destination)
  }
  return audioContext
}

function scheduleTone(
  context: AudioContext,
  frequency: number,
  startAt: number,
  duration: number,
  options: ToneOptions = {},
): void {
  if (masterGain === null) return
  const oscillator = context.createOscillator()
  const gain = context.createGain()
  const stopAt = startAt + duration

  oscillator.type = options.type ?? 'sine'
  oscillator.frequency.setValueAtTime(frequency, startAt)
  if (options.endFrequency !== undefined) {
    oscillator.frequency.exponentialRampToValueAtTime(
      Math.max(1, options.endFrequency),
      stopAt,
    )
  }

  gain.gain.setValueAtTime(0.0001, startAt)
  gain.gain.exponentialRampToValueAtTime(
    options.volume ?? 0.16,
    startAt + Math.min(0.018, duration / 3),
  )
  gain.gain.exponentialRampToValueAtTime(0.0001, stopAt)
  oscillator.connect(gain)
  gain.connect(masterGain)
  oscillator.start(startAt)
  oscillator.stop(stopAt + 0.02)
}

function getNoiseBuffer(context: AudioContext): AudioBuffer {
  if (noiseBuffer !== null && noiseBuffer.sampleRate === context.sampleRate) {
    return noiseBuffer
  }
  const frameCount = Math.ceil(context.sampleRate * 0.35)
  const buffer = context.createBuffer(1, frameCount, context.sampleRate)
  const data = buffer.getChannelData(0)
  let seed = 0x51a9d3
  for (let frame = 0; frame < frameCount; frame += 1) {
    seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0
    data[frame] = (seed / 0xffff_ffff) * 2 - 1
  }
  noiseBuffer = buffer
  return buffer
}

function scheduleNoise(
  context: AudioContext,
  startAt: number,
  duration: number,
  volume: number,
  cutoff: number,
): void {
  if (masterGain === null) return
  const source = context.createBufferSource()
  const filter = context.createBiquadFilter()
  const gain = context.createGain()
  const stopAt = startAt + duration

  source.buffer = getNoiseBuffer(context)
  filter.type = 'lowpass'
  filter.frequency.value = cutoff
  filter.Q.value = 0.7
  gain.gain.setValueAtTime(0.0001, startAt)
  gain.gain.exponentialRampToValueAtTime(volume, startAt + 0.008)
  gain.gain.exponentialRampToValueAtTime(0.0001, stopAt)
  source.connect(filter)
  filter.connect(gain)
  gain.connect(masterGain)
  source.start(startAt)
  source.stop(stopAt + 0.02)
}

function recentlyPlayed(key: string, minimumGapMs: number): boolean {
  const now = performance.now()
  const previous = lastPlayedAt.get(key) ?? Number.NEGATIVE_INFINITY
  if (now - previous < minimumGapMs) return true
  lastPlayedAt.set(key, now)
  return false
}

export function useGameAudio() {
  const soundEnabled = useState<boolean>('sound-enabled', () => true)
  const preferenceLoaded = useState<boolean>(
    'sound-preference-loaded',
    () => false,
  )

  function unlockAudio(): void {
    if (!soundEnabled.value) return
    try {
      const context = ensureAudioGraph()
      if (context?.state === 'suspended') {
        void context.resume().catch(() => undefined)
      }
    } catch {
      // Audio is optional; unsupported or blocked contexts stay silent.
    }
  }

  function withAudio(play: (context: AudioContext) => void): void {
    if (!soundEnabled.value) return
    unlockAudio()
    const context = audioContext
    if (context === null || context.state === 'closed') return
    try {
      play(context)
    } catch {
      // A sound failure must never interrupt simulation or input.
    }
  }

  function playSwap(): void {
    if (recentlyPlayed('swap', 45)) return
    withAudio((context) => {
      const now = context.currentTime
      scheduleTone(context, 310, now, 0.075, {
        type: 'triangle',
        volume: 0.12,
        endFrequency: 455,
      })
      scheduleTone(context, 620, now + 0.018, 0.055, {
        type: 'sine',
        volume: 0.07,
        endFrequency: 760,
      })
    })
  }

  function playClear(normalSize: number, chainLevel: number): void {
    withAudio((context) => {
      const now = context.currentTime
      if (chainLevel > 1) {
        const notes = [392, 523.25, 659.25, 783.99, 1046.5]
        const noteCount = Math.min(notes.length, chainLevel + 2)
        for (let note = 0; note < noteCount; note += 1) {
          scheduleTone(context, notes[note]!, now + note * 0.065, 0.2, {
            type: note % 2 === 0 ? 'triangle' : 'sine',
            volume: 0.13,
          })
        }
        return
      }

      if (normalSize >= 4) {
        const notes = [440, 554.37, 659.25, 880, 1108.73]
        const noteCount = Math.min(notes.length, normalSize - 1)
        for (let note = 0; note < noteCount; note += 1) {
          scheduleTone(context, notes[note]!, now + note * 0.052, 0.17, {
            type: 'triangle',
            volume: 0.12,
          })
        }
        scheduleNoise(context, now + 0.02, 0.1, 0.035, 2_800)
        return
      }

      for (const [note, frequency] of [523.25, 659.25, 783.99].entries()) {
        scheduleTone(context, frequency, now + note * 0.035, 0.13, {
          type: 'sine',
          volume: 0.1,
        })
      }
    })
  }

  function playGarbageReceived(): void {
    if (recentlyPlayed('garbage-received', 120)) return
    withAudio((context) => {
      const now = context.currentTime
      scheduleTone(context, 125, now, 0.22, {
        type: 'sawtooth',
        volume: 0.13,
        endFrequency: 58,
      })
      scheduleNoise(context, now, 0.15, 0.08, 720)
    })
  }

  function playDanger(): void {
    if (recentlyPlayed('danger', 620)) return
    withAudio((context) => {
      const now = context.currentTime
      scheduleTone(context, 466.16, now, 0.13, {
        type: 'square',
        volume: 0.08,
      })
      scheduleTone(context, 349.23, now + 0.14, 0.16, {
        type: 'square',
        volume: 0.07,
      })
    })
  }

  function playRoundResult(result: 'win' | 'loss' | 'draw'): void {
    if (recentlyPlayed('round-result', 800)) return
    withAudio((context) => {
      const now = context.currentTime
      const notes =
        result === 'win'
          ? [523.25, 659.25, 783.99, 1046.5]
          : result === 'draw'
            ? [440, 554.37, 440]
            : [392, 349.23, 293.66]
      for (const [note, frequency] of notes.entries()) {
        scheduleTone(context, frequency, now + note * 0.11, 0.28, {
          type: result === 'win' ? 'triangle' : 'sine',
          volume: result === 'win' ? 0.14 : 0.11,
        })
      }
    })
  }

  function toggleSound(): void {
    soundEnabled.value = !soundEnabled.value
    if (import.meta.client) {
      try {
        localStorage.setItem(
          SOUND_PREFERENCE_KEY,
          String(soundEnabled.value),
        )
      } catch {
        // Persistence is best-effort in private browsing modes.
      }
    }
    if (soundEnabled.value) {
      unlockAudio()
      withAudio((context) => {
        const now = context.currentTime
        scheduleTone(context, 523.25, now, 0.1, {
          type: 'sine',
          volume: 0.08,
        })
        scheduleTone(context, 783.99, now + 0.06, 0.14, {
          type: 'sine',
          volume: 0.08,
        })
      })
    } else if (audioContext?.state === 'running') {
      void audioContext.suspend().catch(() => undefined)
    }
  }

  onMounted(() => {
    if (!preferenceLoaded.value) {
      try {
        soundEnabled.value =
          localStorage.getItem(SOUND_PREFERENCE_KEY) !== 'false'
      } catch {
        soundEnabled.value = true
      }
      preferenceLoaded.value = true
    }
    window.addEventListener('pointerdown', unlockAudio, { once: true })
    window.addEventListener('keydown', unlockAudio, { once: true })
  })

  onBeforeUnmount(() => {
    window.removeEventListener('pointerdown', unlockAudio)
    window.removeEventListener('keydown', unlockAudio)
  })

  return {
    soundEnabled: readonly(soundEnabled),
    unlockAudio,
    playSwap,
    playClear,
    playGarbageReceived,
    playDanger,
    playRoundResult,
    toggleSound,
  }
}
