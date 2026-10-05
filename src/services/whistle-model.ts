/** Public Apache-2.0 Whistle weights and their matching browser runtime. */
export const WHISTLE_MODEL = Object.freeze({
  id: 'Cactus-Compute/whistle',
  revision: 'b358ddadd89b7a713b5aa131f23032d3cca1b251',
  name: 'Whistle',
  license: 'Apache-2.0',
  filename: 'whistle.cact',
  bytes: 16_919_407,
  sha256: 'b6e02f048568ac5d01a2042556c658061e699acbc0aa2a1439f52f3d461dffeb',
  cache: 'typenext-whistle-b358dda-v1',
})

export const WHISTLE_RUNTIME = Object.freeze({
  id: 'Cactus-Compute/needle3',
  revision: 'c7c415a3d1b3d929014bc6e866d51ebb971f7089',
  js: {
    filename: 'needle.js',
    bytes: 62_823,
    sha256: 'f3f7366dcad9555b792ee519d2518f3c506038bcb2ffd179e76e850000749359',
  },
  wasm: {
    filename: 'needle.wasm',
    bytes: 903_655,
    sha256: 'c19b9ddf9c7de4eb4f37e5f1811c5bbea9f099041d2a27284daf89789ee8523d',
  },
})

export const WHISTLE_SAMPLE_RATE = 16_000
export const WHISTLE_MAX_SECONDS = 30
export const WHISTLE_MAX_SAMPLES = WHISTLE_SAMPLE_RATE * WHISTLE_MAX_SECONDS
export const WHISTLE_MAX_TEXT = 12_000

export const WHISTLE_LANGUAGES = [
  { id: '', name: 'Detect language' },
  { id: 'en', name: 'English' },
  { id: 'de', name: 'German' },
  { id: 'fr', name: 'French' },
  { id: 'es', name: 'Spanish' },
  { id: 'it', name: 'Italian' },
  { id: 'nl', name: 'Dutch' },
  { id: 'pl', name: 'Polish' },
] as const

export type WhistleLanguage = (typeof WHISTLE_LANGUAGES)[number]['id']
export interface WhistleTranscript {
  text: string
  language: WhistleLanguage
}

export function validateWhistleLanguage(
  language: unknown
): asserts language is WhistleLanguage {
  if (!WHISTLE_LANGUAGES.some(item => item.id === language))
    throw new Error(
      'Choose one of Whistle’s supported languages or Detect language.'
    )
}

export function whistleModelUrl(): string {
  return `https://huggingface.co/${WHISTLE_MODEL.id}/resolve/${WHISTLE_MODEL.revision}/${WHISTLE_MODEL.filename}`
}

export function validWhistleCache(response: Response | undefined): boolean {
  return Boolean(
    response?.ok &&
    response.headers.get('content-length') === String(WHISTLE_MODEL.bytes) &&
    response.headers.get('x-typenext-sha256') === WHISTLE_MODEL.sha256
  )
}

export function validateWhistleAudio(pcm: Float32Array): void {
  if (
    !(pcm instanceof Float32Array) ||
    pcm.length < 1 ||
    pcm.length > WHISTLE_MAX_SAMPLES
  )
    throw new Error('Record between a moment and 30 seconds of audio.')
  for (const sample of pcm) {
    if (!Number.isFinite(sample) || sample < -1 || sample > 1)
      throw new Error(
        'The microphone returned invalid audio samples. Record again.'
      )
  }
}

export function parseWhistleTranscript(value: unknown): WhistleTranscript {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Whistle returned an invalid transcript. Record again.')
  const result = value as Record<string, unknown>
  if (
    typeof result.text !== 'string' ||
    result.text.length > WHISTLE_MAX_TEXT ||
    result.text.includes('\u0000')
  )
    throw new Error('Whistle returned an invalid transcript. Record again.')
  const language =
    WHISTLE_LANGUAGES.find(item => item.id === result.language)?.id ?? ''
  return { text: result.text.trim(), language }
}
