import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SAMPLE_RATE = 44_100
const OUTPUT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../assets/audio',
)

function waveform(kind, phase) {
  const turn = phase / (Math.PI * 2)
  if (kind === 'triangle') return 2 * Math.abs(2 * (turn - Math.floor(turn + 0.5))) - 1
  if (kind === 'square') return Math.sin(phase) >= 0 ? 1 : -1
  if (kind === 'saw') return 2 * (turn - Math.floor(turn + 0.5))
  return Math.sin(phase)
}

function envelope(time, start, duration, attack = 0.012) {
  const age = time - start
  if (age < 0 || age >= duration) return 0
  const rise = Math.min(1, age / Math.min(attack, duration / 3))
  const decay = Math.max(0, 1 - age / duration)
  return rise * decay * decay
}

function synthesize({ duration, tones = [], noise = null }) {
  const frames = Math.ceil(duration * SAMPLE_RATE)
  const samples = new Float64Array(frames)
  const phases = tones.map(() => 0)
  let noiseState = 0x51a9d3

  for (let frame = 0; frame < frames; frame += 1) {
    const time = frame / SAMPLE_RATE
    let sample = 0

    for (let index = 0; index < tones.length; index += 1) {
      const tone = tones[index]
      const age = time - tone.start
      if (age < 0 || age >= tone.duration) continue
      const progress = age / tone.duration
      const startFrequency = tone.frequency
      const endFrequency = tone.endFrequency ?? startFrequency
      const frequency =
        startFrequency * (endFrequency / startFrequency) ** progress
      phases[index] += (Math.PI * 2 * frequency) / SAMPLE_RATE
      sample +=
        waveform(tone.kind ?? 'sine', phases[index]) *
        envelope(time, tone.start, tone.duration, tone.attack) *
        (tone.volume ?? 0.2)
    }

    if (noise !== null && time >= noise.start && time < noise.start + noise.duration) {
      noiseState =
        (Math.imul(noiseState, 1_664_525) + 1_013_904_223) >>> 0
      const white = (noiseState / 0xffff_ffff) * 2 - 1
      sample +=
        white *
        envelope(time, noise.start, noise.duration, 0.006) *
        noise.volume
    }

    samples[frame] = Math.max(-1, Math.min(1, sample))
  }

  return encodeWav(samples)
}

function encodeWav(samples) {
  const buffer = Buffer.alloc(44 + samples.length * 2)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + samples.length * 2, 4)
  buffer.write('WAVE', 8)
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(SAMPLE_RATE, 24)
  buffer.writeUInt32LE(SAMPLE_RATE * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(samples.length * 2, 40)
  for (let index = 0; index < samples.length; index += 1) {
    buffer.writeInt16LE(Math.round(samples[index] * 32_767), 44 + index * 2)
  }
  return buffer
}

const effects = {
  swap: {
    duration: 0.14,
    tones: [
      { start: 0, duration: 0.075, frequency: 310, endFrequency: 455, kind: 'triangle', volume: 0.45 },
      { start: 0.018, duration: 0.055, frequency: 620, endFrequency: 760, volume: 0.25 },
    ],
  },
  clear: {
    duration: 0.48,
    tones: [523.25, 659.25, 783.99].map((frequency, index) => ({
      start: index * 0.09,
      duration: 0.17,
      frequency,
      kind: 'sine',
      volume: 0.34,
    })),
  },
  combo: {
    duration: 0.72,
    tones: [440, 554.37, 659.25, 880, 1108.73].map((frequency, index) => ({
      start: index * 0.09,
      duration: 0.2,
      frequency,
      kind: 'triangle',
      volume: 0.3,
    })),
    noise: { start: 0.02, duration: 0.1, volume: 0.06 },
  },
  chain: {
    duration: 0.8,
    tones: [392, 523.25, 659.25, 783.99, 1046.5].map((frequency, index) => ({
      start: index * 0.09,
      duration: 0.22,
      frequency,
      kind: index % 2 === 0 ? 'triangle' : 'sine',
      volume: 0.34,
    })),
  },
  garbage_land: {
    duration: 0.34,
    tones: [
      { start: 0, duration: 0.26, frequency: 78, endFrequency: 34, volume: 0.55 },
    ],
    noise: { start: 0, duration: 0.13, volume: 0.18 },
  },
  danger: {
    duration: 0.38,
    tones: [
      { start: 0, duration: 0.13, frequency: 466.16, kind: 'square', volume: 0.2 },
      { start: 0.14, duration: 0.16, frequency: 349.23, kind: 'square', volume: 0.18 },
    ],
  },
  win: {
    duration: 0.8,
    tones: [523.25, 659.25, 783.99, 1046.5].map((frequency, index) => ({
      start: index * 0.11,
      duration: 0.3,
      frequency,
      kind: 'triangle',
      volume: 0.34,
    })),
  },
  lose: {
    duration: 0.7,
    tones: [392, 349.23, 293.66].map((frequency, index) => ({
      start: index * 0.11,
      duration: 0.3,
      frequency,
      endFrequency: frequency * 0.84,
      volume: 0.3,
    })),
  },
  toggle: {
    duration: 0.28,
    tones: [
      { start: 0, duration: 0.1, frequency: 523.25, volume: 0.25 },
      { start: 0.06, duration: 0.14, frequency: 783.99, volume: 0.25 },
    ],
  },
}

mkdirSync(OUTPUT, { recursive: true })
for (const [name, definition] of Object.entries(effects)) {
  writeFileSync(resolve(OUTPUT, `${name}.wav`), synthesize(definition))
}

console.log(`Generated ${Object.keys(effects).length} effects in ${OUTPUT}`)
