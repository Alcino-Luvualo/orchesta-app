export type VoiceInputState =
  | 'idle'
  | 'requesting-permission'
  | 'recording'
  | 'processing'
  | 'inserting'
  | 'error'
  | 'cancelled'

export type VoiceTranscriptPhase = 'recording' | 'processing'

export interface TerminalTranscriptionProvider {
  id: string
  label: string
  audioLeavesMachine: boolean
  networkDisclosure: string
  transcribe(options: {
    signal: AbortSignal
    onTranscript: (text: string) => void
    onPhase: (phase: VoiceTranscriptPhase) => void
  }): Promise<void>
}

export type MicrophonePermissionRequester = (signal: AbortSignal) => Promise<'granted' | 'denied'>

export type VoiceInputSnapshot = {
  state: VoiceInputState
  terminalId: string | null
  error: string | null
}

type VoiceInputCallbacks = {
  currentTerminalId: () => string
  insert: (text: string) => void
  update: (snapshot: VoiceInputSnapshot) => void
}

export class TerminalVoiceController {
  private generation = 0
  private abortController: AbortController | null = null
  private activeTerminalId: string | null = null
  private callbacks: VoiceInputCallbacks | null = null
  private snapshot: VoiceInputSnapshot = { state: 'idle', terminalId: null, error: null }

  get current(): VoiceInputSnapshot { return this.snapshot }

  private publish(state: VoiceInputState, error: string | null = null): void {
    this.snapshot = { state, terminalId: this.activeTerminalId, error }
    this.callbacks?.update(this.snapshot)
  }

  async start(options: {
    terminalId: string
    permission: MicrophonePermissionRequester
    provider: TerminalTranscriptionProvider
    callbacks: VoiceInputCallbacks
  }): Promise<void> {
    this.cancel(false)
    const generation = ++this.generation
    const abortController = new AbortController()
    this.abortController = abortController
    this.activeTerminalId = options.terminalId
    this.callbacks = options.callbacks
    let inserted = false
    let phase: VoiceTranscriptPhase = 'recording'
    this.publish('requesting-permission')
    try {
      const permission = await options.permission(abortController.signal)
      if (generation !== this.generation || abortController.signal.aborted) return
      if (permission !== 'granted') throw new Error('Permissão de microfone negada.')
      this.publish('recording')
      await options.provider.transcribe({
        signal: abortController.signal,
        onPhase: (nextPhase) => {
          if (generation !== this.generation || abortController.signal.aborted) return
          phase = nextPhase
          this.publish(nextPhase)
        },
        onTranscript: (text) => {
          if (generation !== this.generation || abortController.signal.aborted) return
          if (options.callbacks.currentTerminalId() !== options.terminalId) {
            this.cancel()
            return
          }
          const chunk = text.trim()
          if (!chunk) return
          this.publish('inserting')
          options.callbacks.insert(`${inserted ? ' ' : ''}${chunk}`)
          inserted = true
          this.publish(phase)
        }
      })
      if (generation !== this.generation || abortController.signal.aborted) return
      if (!inserted) throw new Error('Nenhuma fala foi detetada.')
      this.publish('idle')
    } catch (error) {
      if (generation !== this.generation || abortController.signal.aborted) return
      this.publish('error', error instanceof Error ? error.message : 'Falha na transcrição.')
    } finally {
      if (generation === this.generation) {
        this.abortController = null
        this.activeTerminalId = null
      }
    }
  }

  cancel(publish = true): void {
    this.generation += 1
    this.abortController?.abort()
    this.abortController = null
    if (publish && (this.activeTerminalId || this.snapshot.state !== 'idle')) this.publish('cancelled')
    this.activeTerminalId = null
  }

  terminalChanged(terminalId: string): void {
    if (this.activeTerminalId && this.activeTerminalId !== terminalId) this.cancel()
  }

  reset(): void {
    this.activeTerminalId = null
    this.publish('idle')
  }
}

type SpeechRecognitionResultLike = {
  isFinal: boolean
  0?: { transcript?: string }
}

type SpeechRecognitionLike = {
  continuous: boolean
  interimResults: boolean
  lang: string
  onresult: ((event: { resultIndex?: number; results: ArrayLike<SpeechRecognitionResultLike> }) => void) | null
  onaudioend: (() => void) | null
  onerror: ((event: { error?: string; message?: string }) => void) | null
  onend: (() => void) | null
  start: () => void
  abort: () => void
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike

function resampleAudio(input: Float32Array, inputRate: number, outputRate = 16_000): Float32Array {
  if (inputRate === outputRate) return input
  const length = Math.max(1, Math.round(input.length * outputRate / inputRate))
  const output = new Float32Array(length)
  for (let index = 0; index < length; index += 1) {
    const source = index * inputRate / outputRate
    const left = Math.floor(source)
    const right = Math.min(input.length - 1, left + 1)
    const ratio = source - left
    output[index] = input[left] * (1 - ratio) + input[right] * ratio
  }
  return output
}

async function captureMicrophone(signal: AbortSignal): Promise<Float32Array> {
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    throw new Error('A captura local de áudio não está disponível neste sistema.')
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
  })
  const AudioContextClass = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AudioContextClass) {
    stream.getTracks().forEach((track) => track.stop())
    throw new Error('O processamento local de áudio não está disponível.')
  }
  const context = new AudioContextClass()
  await context.resume()
  const source = context.createMediaStreamSource(stream)
  const analyser = context.createAnalyser()
  analyser.fftSize = 1024
  source.connect(analyser)
  const recorder = new MediaRecorder(stream)
  const chunks: Blob[] = []

  try {
    const blob = await new Promise<Blob>((resolve, reject) => {
      let settled = false
      let heardSpeech = false
      let lastSpeechAt = Date.now()
      const startedAt = Date.now()
      const samples = new Uint8Array(analyser.fftSize)
      const finish = (error?: Error) => {
        if (settled) return
        settled = true
        window.clearInterval(meter)
        signal.removeEventListener('abort', abort)
        if (recorder.state !== 'inactive') recorder.stop()
        if (error) reject(error)
      }
      const abort = () => finish(new DOMException('Voice input cancelled', 'AbortError'))
      const meter = window.setInterval(() => {
        analyser.getByteTimeDomainData(samples)
        let energy = 0
        for (const value of samples) energy += ((value - 128) / 128) ** 2
        const rms = Math.sqrt(energy / samples.length)
        const now = Date.now()
        if (rms > .025) {
          heardSpeech = true
          lastSpeechAt = now
        }
        if (heardSpeech && now - lastSpeechAt > 1_150 && now - startedAt > 1_400) finish()
        else if (now - startedAt > 12_000) finish()
      }, 100)
      recorder.addEventListener('dataavailable', (event) => { if (event.data.size) chunks.push(event.data) })
      recorder.addEventListener('error', () => finish(new Error('Falha ao gravar o microfone.')))
      recorder.addEventListener('stop', () => {
        if (!settled) {
          settled = true
          window.clearInterval(meter)
          signal.removeEventListener('abort', abort)
        }
        if (!signal.aborted) resolve(new Blob(chunks, { type: recorder.mimeType }))
      }, { once: true })
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
      else recorder.start(200)
    })
    const decoded = await context.decodeAudioData(await blob.arrayBuffer())
    const mono = new Float32Array(decoded.length)
    for (let channel = 0; channel < decoded.numberOfChannels; channel += 1) {
      const values = decoded.getChannelData(channel)
      for (let index = 0; index < values.length; index += 1) mono[index] += values[index] / decoded.numberOfChannels
    }
    return resampleAudio(mono, decoded.sampleRate)
  } finally {
    source.disconnect()
    stream.getTracks().forEach((track) => track.stop())
    await context.close().catch(() => undefined)
  }
}

function transcribeWithLocalWhisper(audio: Float32Array, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./voiceWhisperWorker.ts', import.meta.url), { type: 'module' })
    const finish = (error?: Error, text = '') => {
      signal.removeEventListener('abort', abort)
      worker.terminate()
      if (error) reject(error)
      else resolve(text)
    }
    const abort = () => finish(new DOMException('Voice input cancelled', 'AbortError'))
    worker.addEventListener('message', (event: MessageEvent<{ type?: string; text?: string; error?: string }>) => {
      if (event.data.type === 'result') finish(undefined, event.data.text || '')
      else if (event.data.type === 'error') {
        finish(new Error(`A transcrição local falhou: ${event.data.error || 'erro desconhecido'}`))
      }
    })
    worker.addEventListener('error', (event) => finish(new Error(`A transcrição local falhou: ${event.message}`)), { once: true })
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    else worker.postMessage({ audio, language: 'portuguese' }, [audio.buffer])
  })
}

export function createLocalWhisperProvider(): TerminalTranscriptionProvider | null {
  if (typeof window === 'undefined' || typeof Worker === 'undefined' || typeof MediaRecorder === 'undefined') return null
  return {
    id: 'local-whisper',
    label: 'Whisper local',
    audioLeavesMachine: false,
    networkDisclosure: 'O áudio fica neste computador. Na primeira utilização, o modelo multilíngue é descarregado e guardado na cache local.',
    transcribe: async ({ signal, onTranscript, onPhase }) => {
      const audio = await captureMicrophone(signal)
      if (signal.aborted) return
      onPhase('processing')
      const transcript = await transcribeWithLocalWhisper(audio, signal)
      if (transcript) onTranscript(transcript)
    }
  }
}

export function createBrowserSpeechRecognitionProvider(scope: typeof globalThis = globalThis): TerminalTranscriptionProvider | null {
  const candidate = scope as typeof globalThis & {
    SpeechRecognition?: SpeechRecognitionConstructor
    webkitSpeechRecognition?: SpeechRecognitionConstructor
    navigator?: Navigator
  }
  const Recognition = candidate.SpeechRecognition || candidate.webkitSpeechRecognition
  if (!Recognition) return null
  return {
    id: 'chromium-speech-recognition',
    label: 'Reconhecimento de voz do Chromium',
    audioLeavesMachine: true,
    networkDisclosure: 'O Chromium ou o sistema pode enviar o áudio ao provider de reconhecimento configurado. O Orchestra não guarda o áudio.',
    transcribe: ({ signal, onTranscript, onPhase }) => new Promise<void>((resolve, reject) => {
      const recognition = new Recognition()
      let settled = false
      const finish = (error?: Error) => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', abort)
        if (error) reject(error)
        else resolve()
      }
      const abort = () => {
        try { recognition.abort() } catch { /* recognition already ended */ }
        finish(new DOMException('Voice input cancelled', 'AbortError'))
      }
      recognition.continuous = true
      recognition.interimResults = false
      recognition.lang = candidate.navigator?.language || 'pt-PT'
      recognition.onresult = (event) => {
        for (let index = event.resultIndex || 0; index < event.results.length; index += 1) {
          const result = event.results[index]
          if (result?.isFinal) onTranscript(result[0]?.transcript || '')
        }
      }
      recognition.onaudioend = () => onPhase('processing')
      recognition.onerror = (event) => {
        if (event.error === 'aborted') finish(new DOMException('Voice input cancelled', 'AbortError'))
        else if (event.error === 'no-speech') finish()
        else finish(new Error(event.message || `Falha no provider de voz: ${event.error || 'desconhecida'}`))
      }
      recognition.onend = () => finish()
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
      else recognition.start()
    })
  }
}

export async function requestBrowserMicrophonePermission(signal: AbortSignal): Promise<'granted' | 'denied'> {
  if (!navigator.mediaDevices?.getUserMedia || signal.aborted) return 'denied'
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    stream.getTracks().forEach((track) => track.stop())
    return signal.aborted ? 'denied' : 'granted'
  } catch {
    return 'denied'
  }
}
