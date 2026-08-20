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
