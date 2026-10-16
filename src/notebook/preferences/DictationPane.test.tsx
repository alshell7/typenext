import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SpeechRuntimeStatus } from '../../services/speech-runtime'
import type {
  DictationRecording,
  DictationRecordingOptions,
} from '../../services/whistle-recorder'
import { defaultSettings } from '../model'
import type { DictationSettings, NotebookSettings } from '../../types/notebook'

const mock = vi.hoisted(() => ({
  speech: {
    state: 'idle',
    installed: { runtime: false, model: false },
    diskBytes: 0,
  } as SpeechRuntimeStatus,
  listeners: new Set<() => void>(),
  refresh: vi.fn(),
  cancel: vi.fn(),
  remove: vi.fn(),
  stop: vi.fn(),
  endpoint: vi.fn(),
  download: vi.fn(),
  list: vi.fn(),
  record: vi.fn(),
}))
vi.mock('../../services/speech-runtime', async importOriginal => ({
  ...(await importOriginal<typeof import('../../services/speech-runtime')>()),
  getSpeechRuntimeStatus: () => mock.speech,
  subscribeSpeechRuntime: (listener: () => void) => {
    mock.listeners.add(listener)
    return () => {
      mock.listeners.delete(listener)
    }
  },
  refreshSpeechRuntime: mock.refresh,
  cancelSpeechInstall: mock.cancel,
  removeSpeechRuntime: mock.remove,
  stopSpeechRuntime: mock.stop,
  speechEndpoint: mock.endpoint,
}))
vi.mock('../../services/fluid-speech', () => ({
  downloadFluidSpeech: mock.download,
}))
vi.mock('../../services/whistle-microphones', () => ({
  listWhistleMicrophones: mock.list,
  subscribeWhistleMicrophoneChanges: () => () => undefined,
}))
vi.mock('../../services/whistle-recorder', () => ({
  startDictationRecording: mock.record,
}))
vi.mock('../WhistleModelPanel', () => ({
  WhistleModelPanel: () => <section aria-label="Offline dictation model" />,
}))
import { DictationPane } from './DictationPane'
import { resetDictationInputForTests } from '../dictation/input-preference'

function publish(next: Partial<SpeechRuntimeStatus>) {
  mock.speech = { ...mock.speech, ...next }
  mock.listeners.forEach(listener => listener())
}
function setup(dictation: Partial<DictationSettings> = {}) {
  let settings: NotebookSettings = {
    ...defaultSettings(),
    dictation: { ...defaultSettings().dictation, ...dictation },
  }
  const update = vi.fn((patch: Partial<NotebookSettings>) => {
    settings = { ...settings, ...patch }
    view.rerender(
      <DictationPane
        settings={settings}
        update={update}
        latest={() => settings}
      />
    )
  })
  const view = render(
    <DictationPane
      settings={settings}
      update={update}
      latest={() => settings}
    />
  )
  return { update, current: () => settings }
}

beforeEach(() => {
  localStorage.clear()
  resetDictationInputForTests()
  mock.listeners.clear()
  mock.speech = {
    state: 'idle',
    installed: { runtime: false, model: false },
    diskBytes: 0,
  }
  mock.refresh.mockReset().mockImplementation(async () => mock.speech)
  mock.cancel.mockReset().mockResolvedValue(undefined)
  mock.remove.mockReset().mockImplementation(async () => {
    publish({ installed: { runtime: false, model: false }, diskBytes: 0 })
    return mock.speech
  })
  mock.stop.mockReset().mockResolvedValue(undefined)
  mock.endpoint.mockReset().mockResolvedValue('http://127.0.0.1:1')
  mock.download.mockReset().mockResolvedValue({})
  mock.list.mockReset().mockResolvedValue([
    { deviceId: '', label: 'System default' },
    { deviceId: 'usb-1', label: 'USB microphone' },
  ])
  mock.record.mockReset()
})
afterEach(() => {
  cleanup()
})

describe('Dictation preferences', () => {
  it('chooses between the two engines', async () => {
    const { update, current } = setup()
    expect(screen.getByRole('radio', { name: /Whistle/ })).toHaveAttribute(
      'aria-checked',
      'true'
    )
    expect(
      screen.getByRole('region', { name: 'Offline dictation model' })
    ).toBeInTheDocument()
    expect(
      screen.getByText(/7 languages, clips up to 30 seconds/)
    ).toBeVisible()
    await userEvent
      .setup()
      .click(screen.getByRole('radio', { name: /Fluid Speech Mini/ }))
    expect(update).toHaveBeenCalledWith({
      dictation: expect.objectContaining({ engine: 'fluid' }),
    })
    expect(current().dictation.engine).toBe('fluid')
    expect(
      screen.getByRole('group', { name: 'Fluid Speech Mini runtime' })
    ).toBeVisible()
    expect(
      screen.getByText(/Fluid Speech Mini by FluidVoice · CC BY 4.0 · 347 MB/)
    ).toBeVisible()
    // Fluid is English only: no language choice.
    expect(screen.queryByRole('combobox', { name: 'Language' })).toBeNull()
  })

  it('downloads, shows progress, cancels, starts, stops and removes Fluid Speech Mini', async () => {
    setup({ engine: 'fluid' })
    const user = userEvent.setup()
    expect(screen.getByText('Not installed')).toBeVisible()
    await user.click(
      screen.getByRole('button', {
        name: 'Download Fluid Speech Mini (347 MB)',
      })
    )
    expect(mock.download).toHaveBeenCalledTimes(1)
    act(() =>
      publish({
        state: 'downloading',
        progress: {
          file: 'fluid-speech-mini.gguf',
          downloadedBytes: 100,
          totalBytes: 400,
        },
      })
    )
    expect(screen.getByText('Downloading 25%')).toBeVisible()
    expect(
      screen.getByRole('progressbar', { name: 'Fluid Speech Mini download' })
    ).toHaveAttribute('aria-valuenow', '25')
    await user.click(screen.getByRole('button', { name: 'Cancel download' }))
    expect(mock.cancel).toHaveBeenCalledTimes(1)
    act(() =>
      publish({
        state: 'idle',
        progress: undefined,
        installed: { runtime: true, model: true },
        diskBytes: 350_000_000,
      })
    )
    expect(screen.getByText('Installed')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Start' }))
    expect(mock.endpoint).toHaveBeenCalledTimes(1)
    act(() => publish({ state: 'running', running: { endpoint: 'x' } }))
    expect(screen.getByText('Running')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Stop' }))
    expect(mock.stop).toHaveBeenCalledTimes(1)
    await user.click(screen.getByRole('button', { name: 'Remove' }))
    expect(screen.getByText('Remove 350 MB?')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Remove' }))
    expect(mock.remove).toHaveBeenCalledTimes(1)
  })

  it('reports download failures and a missing desktop runtime gracefully', async () => {
    mock.refresh.mockRejectedValueOnce(
      new Error('Command speech_runtime_status not found')
    )
    mock.download.mockResolvedValue({
      error: 'Hugging Face asked for a token. Follow the guide to continue.',
    })
    setup({ engine: 'fluid' })
    expect(
      await screen.findByText('Command speech_runtime_status not found')
    ).toBeVisible()
    await userEvent.setup().click(
      screen.getByRole('button', {
        name: 'Download Fluid Speech Mini (347 MB)',
      })
    )
    expect(
      await screen.findByText(
        'Hugging Face asked for a token. Follow the guide to continue.'
      )
    ).toBeVisible()
  })

  it('explains that Fluid Speech Mini needs the desktop app in a browser', () => {
    mock.speech = { ...mock.speech, state: 'unsupported' }
    setup({ engine: 'fluid' })
    expect(screen.getByText('Desktop app only')).toBeVisible()
    expect(
      screen.getByRole('button', {
        name: 'Download Fluid Speech Mini (347 MB)',
      })
    ).toBeDisabled()
  })

  it('sets the silence auto-stop, live phrases and voice commands', async () => {
    const { current } = setup({ engine: 'fluid' })
    const slider = screen.getByRole('slider', { name: 'Stop after silence' })
    expect(slider).toHaveAttribute('max', '15')
    fireEvent.change(slider, { target: { value: '0' } })
    expect(current().dictation.silenceStopSeconds).toBe(0)
    expect(screen.getByText('Off')).toBeVisible()
    fireEvent.change(slider, { target: { value: '7' } })
    expect(current().dictation.silenceStopSeconds).toBe(7)
    const user = userEvent.setup()
    await user.click(
      screen.getByRole('switch', { name: /Insert phrases while speaking/ })
    )
    expect(current().dictation.livePhrases).toBe(false)
    expect(screen.getByRole('list', { name: 'Voice commands' })).toBeVisible()
    expect(screen.getByText('“scratch that”')).toBeVisible()
    await user.click(screen.getByRole('switch', { name: /Voice commands/ }))
    expect(current().dictation.voiceCommands).toBe(false)
    expect(screen.queryByText('“scratch that”')).toBeNull()
  })

  it('keeps live phrases for Fluid Speech Mini only', () => {
    setup({ engine: 'whistle' })
    expect(
      screen.getByRole('switch', { name: /Insert phrases while speaking/ })
    ).toBeDisabled()
  })

  it('chooses the microphone and Whistle language for this device', async () => {
    setup()
    await screen.findByRole('option', { name: 'USB microphone' })
    expect(mock.list).toHaveBeenCalledWith(
      expect.objectContaining({ requestPermission: false })
    )
    const user = userEvent.setup()
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Input' }),
      'usb-1'
    )
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Language' }),
      'de'
    )
    expect(
      JSON.parse(localStorage.getItem('typenext:dictation-input:v1')!)
    ).toEqual({ deviceId: 'usb-1', language: 'de' })
    await user.click(
      screen.getByRole('button', { name: 'Allow and refresh microphones' })
    )
    expect(mock.list).toHaveBeenLastCalledWith(
      expect.objectContaining({ requestPermission: true })
    )
  })

  it('tests the microphone level with speech detection', async () => {
    let options!: DictationRecordingOptions
    let done!: () => void
    mock.record.mockImplementation(async (value: DictationRecordingOptions) => {
      options = value
      const recording: DictationRecording = {
        finished: new Promise<void>(resolve => (done = resolve)),
        stop: vi.fn(),
        cancel: vi.fn(),
      }
      return recording
    })
    setup()
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Test microphone' }))
    expect(options.maxSeconds).toBe(5)
    expect(screen.getByText('Say a few words…')).toBeVisible()
    const speech = new Float32Array(16_000)
    for (let index = 0; index < speech.length; index++)
      speech[index] = 0.2 * Math.sin(index / 6)
    act(() => {
      for (let at = 0; at < speech.length; at += 1_600)
        options.onChunk(speech.subarray(at, at + 1_600))
    })
    expect(
      Number(
        screen
          .getByRole('meter', { name: 'Microphone level' })
          .getAttribute('aria-valuenow')
      )
    ).toBeGreaterThan(50)
    await act(async () => {
      done()
    })
    expect(
      screen.getByText('Speech heard clearly. This microphone is ready.')
    ).toBeVisible()
  })

  it('accepts an onChange callback instead of update', async () => {
    const onChange = vi.fn()
    render(<DictationPane settings={defaultSettings()} onChange={onChange} />)
    await userEvent
      .setup()
      .click(screen.getByRole('radio', { name: /Fluid Speech Mini/ }))
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ engine: 'fluid', silenceStopSeconds: 4 })
    )
  })
})
