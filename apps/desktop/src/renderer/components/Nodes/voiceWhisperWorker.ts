import { env, pipeline } from '@huggingface/transformers'

type WhisperResult = { text?: string }
type WhisperTranscriber = (
  audio: Float32Array,
  options: { language: string; task: 'transcribe' }
) => Promise<WhisperResult | WhisperResult[]>

let transcriberPromise: Promise<WhisperTranscriber> | null = null

function localTranscriber() {
  if (!transcriberPromise) {
    env.allowLocalModels = false
    env.useBrowserCache = true
    transcriberPromise = pipeline(
      'automatic-speech-recognition',
      'onnx-community/whisper-tiny',
      {
        device: 'wasm',
        dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' }
      }
    ) as unknown as Promise<WhisperTranscriber>
  }
  return transcriberPromise
}

self.addEventListener('message', async (event: MessageEvent<{ audio?: Float32Array; language?: string }>) => {
  try {
    if (!(event.data.audio instanceof Float32Array) || event.data.audio.length === 0) {
      throw new Error('A gravação de voz está vazia.')
    }
    const transcriber = await localTranscriber()
    const output = await transcriber(event.data.audio, {
      language: event.data.language || 'portuguese',
      task: 'transcribe'
    })
    const first = Array.isArray(output) ? output[0] : output
    self.postMessage({ type: 'result', text: String(first?.text || '').trim() })
  } catch (error) {
    self.postMessage({
      type: 'error',
      error: error instanceof Error ? error.message : String(error)
    })
  }
})
