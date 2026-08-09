import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { parseCommand } from './agent'
import {
  createCloudClient,
  loadCloudSettings,
  saveCloudSettings,
} from './cloudClient'
import { isNativeCredentialStorage } from './nativeSecureStorage'
import { createPhoneBrainSession } from './brain/phoneBrain'
import {
  prefersCloudSpeechToText,
  startCloudVoiceCapture,
} from './voiceCapture'
import {
  buildPlanSpeech,
  buildResultSpeech,
  speakText,
  stopSpeaking,
  unlockSpeechAudio,
} from './speak'
import { executePlan } from './tools'
import { DashboardPanel } from './DashboardPanel'
import {
  hydrateDashboardState,
  rememberDashboardSession,
} from './dashboardState'
import {
  loadLocalSessions,
  upsertLocalSession,
} from './sessionStorage'
import { loadSimulatorState, saveSimulatorState } from './storage'
import './styles.css'
import './pendant.css'

const advancedExamples = [
  'Open Calendar on my Mac.',
  'Open my AI pendant project in VS Code.',
  'Draft an email to David about computing resources and copy it to clipboard.',
  'Search my Downloads folder for simulator zip.',
]

function App() {
  const [command, setCommand] = useState('Open Gmail on my Mac.')
  const [mode, setMode] = useState(getDefaultConnectionMode)
  const [macAgentUrl, setMacAgentUrl] = useState(loadSavedAgentUrl)
  const [agentToken, setAgentToken] = useState(loadSavedAgentToken)
  const [cloudSettings, setCloudSettings] = useState(loadCloudSettings)
  const [macStatus, setMacStatus] = useState('Disconnected')
  const [remoteStatus, setRemoteStatus] = useState('Disconnected')
  const [remoteHealth, setRemoteHealth] = useState(null)
  const [macLogs, setMacLogs] = useState([])
  const [contextGraph, setContextGraph] = useState(null)
  const [pendingPlan, setPendingPlan] = useState(null)
  const [message, setMessage] = useState('')
  const [result, setResult] = useState('')
  const [pendantStatus, setPendantStatus] = useState('Idle')
  const [isListening, setIsListening] = useState(false)
  const [isAdvancedOpen, setIsAdvancedOpen] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showComposer, setShowComposer] = useState(false)
  const [isExecuting, setIsExecuting] = useState(false)
  const [showDashboard, setShowDashboard] = useState(false)
  const [sessions, setSessions] = useState(() => hydrateDashboardState().sessions)
  const [activeSessionId, setActiveSessionId] = useState(
    () => hydrateDashboardState().activeSessionId,
  )
  const [simulatorState, setSimulatorState] = useState(() =>
    loadSimulatorState(),
  )
  const timers = useRef([])
  const recognitionRef = useRef(null)
  const cloudVoiceRef = useRef(null)
  const ignoreAbortRef = useRef(false)
  const transcriptRef = useRef('')
  const listeningModeRef = useRef(false)
  const voiceOriginRef = useRef(false)

  const cloudClient = useMemo(
    () => createCloudClient(cloudSettings),
    [cloudSettings],
  )

  const announce = useCallback(
    (text) => {
      const cleaned = String(text || '').trim()
      if (!cleaned) {
        return
      }

      // Remote/mobile/brain: prefetch cloud TTS while browser speech starts.
      const useCloudVoice = mode === 'remote' || mode === 'brain'
      void speakText(cleaned, {
        preferCloud: useCloudVoice,
        mode,
        cloudSpeak: useCloudVoice
          ? (payload) => cloudClient.speakText(payload)
          : null,
      })
    },
    [cloudClient, mode],
  )

  /*
   * The phone's own brain. Rebuilt only when the client is, so the credential
   * and the inference transport are shared with every other relay call the app
   * makes — there is exactly one thing in this app that holds the token.
   */
  const phoneBrain = useMemo(
    () =>
      createPhoneBrainSession({
        client: cloudClient,
        deviceId: cloudSettings.mobileDeviceId,
        speak: (text) => announce(text),
      }),
    [announce, cloudClient, cloudSettings.mobileDeviceId],
  )

  /*
   * The mesh doorbell, for as long as this app is mounted.
   *
   * The node-mesh inbox is durable, so mail is never lost without this — it is
   * simply not noticed until the model happens to call mesh_inbox. The socket
   * is what turns that into an arrival: it drains on every {"type":"mail"}
   * frame and on every connect, since mail queued while the phone was offline
   * rang a doorbell nobody heard. It degrades to nothing when the phone is
   * unpaired or the platform has no WebSocket, and it never throws in here.
   */
  useEffect(() => phoneBrain.startMeshListener(), [phoneBrain])

  /*
   * The brain's confirmation gate, held open across a render.
   *
   * runMobileBrain calls `confirm` ONLY when the model asked for permission,
   * and then awaits an answer. There is no rule on this side that decides to
   * open it — that judgement is the model's, per llmPlanner's design — so this
   * is a plain promise the pendant tap resolves.
   *
   * `brainAsking` exists because the loop is still running while it waits, and
   * every confirm control in this app is disabled on `isExecuting`. Without it
   * the model asks a question the owner physically cannot answer — the tap, the
   * Confirm button and the Cancel button were all dead, and the turn hung until
   * it timed out. Found by clicking it, not by reading it.
   */
  const brainConfirmRef = useRef(null)
  const [brainAsking, setBrainAsking] = useState(false)

  const isConnected = mode === 'brain'
    ? remoteStatus === 'Connected'
    : mode === 'remote'
      ? remoteStatus === 'Connected' && remoteHealth?.macBridgeOnline
      : macStatus === 'Connected'

  const clearTimers = useCallback(() => {
    timers.current.forEach((timer) => window.clearTimeout(timer))
    timers.current = []
  }, [])

  const fetchSessions = useCallback(async () => {
    if (mode === 'mock') {
      setSessions(loadLocalSessions())
      return
    }

    try {
      const baseUrl = mode === 'remote' ? cloudSettings.relayUrl : macAgentUrl
      const token =
        mode === 'remote' ? cloudSettings.relayApiKey : agentToken

      if (mode === 'remote') {
        const productState = await cloudClient.getProductState()
        setSessions(
          (productState?.sessions ?? []).filter((session) => !session.deletedAt),
        )
        return
      }

      const response = await fetch(`${baseUrl}/sessions`, {
        headers: authHeaders(token),
      })
      const payload = await response.json()

      if (!response.ok) {
        throw new Error(payload.error ?? 'Sessions could not be loaded.')
      }

      setSessions(payload.sessions ?? [])
    } catch {
      setSessions(loadLocalSessions())
    }
  }, [agentToken, cloudClient, cloudSettings.relayApiKey, cloudSettings.relayUrl, macAgentUrl, mode])

  const fetchContextGraph = useCallback(async () => {
    const response = await fetch(`${macAgentUrl}/context-graph`, {
      headers: authHeaders(agentToken),
    })
    const payload = await response.json()

    if (!response.ok) {
      throw new Error(payload.error ?? 'Context graph could not be loaded.')
    }

    setContextGraph(payload.graph)
  }, [agentToken, macAgentUrl])

  const checkRemoteRelay = useCallback(async () => {
    try {
      const health = await cloudClient.checkHealth()
      await cloudClient.registerMobile()
      setRemoteHealth(health)
      setRemoteStatus('Connected')

      if (health.macBridgeOnline) {
        setMessage('Connected to home MacBook via cloud')
      } else {
        setMessage(
          'Cloud relay is online, but the home Mac bridge is offline. Start it on your MacBook.',
        )
      }
    } catch (error) {
      setRemoteStatus('Disconnected')
      setRemoteHealth(null)
      setMessage(
        error.message
          ? `Disconnected: ${error.message}`
          : 'Disconnected. Check relay URL or API key.',
      )
    }
  }, [cloudClient])

  const checkMacAgent = useCallback(async () => {
    try {
      const healthResponse = await fetch(`${macAgentUrl}/health`)

      if (!healthResponse.ok) {
        throw new Error('Mac agent health check failed.')
      }

      const logsResponse = await fetch(`${macAgentUrl}/logs`, {
        headers: authHeaders(agentToken),
      })
      const payload = await logsResponse.json()

      if (!logsResponse.ok) {
        throw new Error(payload.error ?? 'Token check failed.')
      }

      setMacStatus('Connected')
      setMacLogs(payload.logs ?? [])
      await fetchContextGraph()
      setMessage('Connected to MacBook')
    } catch (error) {
      setMacStatus('Disconnected')
      setMessage(
        error.message
          ? `Disconnected: ${error.message}`
          : 'Disconnected. Check the agent URL or token.',
      )
    }
  }, [agentToken, fetchContextGraph, macAgentUrl])

  function handleModeChange(nextMode) {
    setMode(nextMode)

    /* The brain talks to the same relay as remote mode; what differs is who
     * does the thinking, so the same reachability check applies. */
    if (nextMode === 'remote' || nextMode === 'brain') {
      checkRemoteRelay()
    } else if (nextMode === 'mac') {
      checkMacAgent()
    }
  }

  useEffect(() => {
    saveSimulatorState(simulatorState)
  }, [simulatorState])

  useEffect(() => {
    return () => clearTimers()
  }, [clearTimers])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (mode === 'remote' || mode === 'brain') {
        checkRemoteRelay()
      } else if (mode === 'mac') {
        checkMacAgent()
      }
    }, 0)
    return () => window.clearTimeout(timer)
  }, [checkMacAgent, checkRemoteRelay, mode])

  const rawPlan = useMemo(() => {
    if (!pendingPlan || pendingPlan.status === 'error') {
      return ''
    }

    return JSON.stringify(pendingPlan.parameters, null, 2)
  }, [pendingPlan])

  function handleRunAgent() {
    runAgentFromCommand(command, {
      showListening: false,
    })
  }

  function runAgentFromCommand(commandToRun, { showListening = false } = {}) {
    clearTimers()
    setPendingPlan(null)
    setResult('')
    setMessage(showListening ? 'Listening...' : 'Thinking...')
    setPendantStatus(showListening ? 'Listening...' : 'Thinking...')

    if (showListening) {
      timers.current.push(
        window.setTimeout(() => {
          setMessage('Thinking...')
          setPendantStatus('Thinking...')
        }, 260),
      )
    }

    timers.current.push(
      window.setTimeout(
        () => {
          if (mode === 'brain') {
            runPhoneBrain(commandToRun)
          } else if (mode === 'remote') {
            requestRemotePlan(commandToRun)
          } else if (mode === 'mac') {
            requestMacPlan(commandToRun)
          } else {
            const plan = parseCommand(commandToRun)
            preparePlan(plan, 'mock')
          }
        },
        showListening ? 720 : 260,
      ),
    )
  }

  /*
   * The phone thinks for itself.
   *
   * Unlike every other path here, this one does not hand the command somewhere
   * and wait for a plan to confirm — the loop runs on this device, narrates
   * itself as it goes, and only stops to ask when the MODEL decided to ask. The
   * Mac is one tool it may choose, so this path still works with the laptop
   * asleep, which is the entire reason it exists.
   */
  async function runPhoneBrain(commandToRun) {
    setIsExecuting(true)
    setPendantStatus('Thinking...')

    try {
      const outcome = await phoneBrain.run(commandToRun, {
        sessionId: activeSessionId || undefined,
        onProgress: (event) => {
          if (event.phase === 'confirm') return // the gate below narrates itself
          if (event.message) setMessage(event.message)
          if (event.phase === 'tool') setPendantStatus('Working...')
        },
        confirm: ({ actions, reason }) =>
          new Promise((resolve) => {
            /* Reuse the pendant's existing confirm gesture rather than
             * inventing a second one: the owner already knows this shape. */
            brainConfirmRef.current = resolve
            setBrainAsking(true)
            setPendingPlan({
              status: 'ready',
              mode: 'brain_confirm',
              action: 'Permission',
              summary: reason || 'The phone is asking before it does something extra.',
              executionMode: 'brain',
              actions: actions.map((action, index) => ({
                step: index + 1,
                action: action.label || action.tool,
                tool: action.tool,
                summary: action.label || action.tool,
                parameters: action.params ?? {},
              })),
              parameters: actions.map((action, index) => ({
                step: index + 1,
                tool: action.tool,
                parameters: action.params ?? {},
              })),
            })
            setPendantStatus('Ready')
            setMessage(reason || 'May I?')
            announce(reason || 'May I?')
          }),
      })

      setPendingPlan(null)
      setResult(outcome.say)
      setPendantStatus(outcome.status === 'done' ? 'Done' : 'Idle')
      setMessage(outcome.status === 'done' ? 'Done' : outcome.status)
      announce(outcome.say)
      setRemoteStatus('Connected')
    } catch (error) {
      /* relayInference names the two cases an owner can act on — no route
       * deployed yet, or this phone was revoked — so show the real sentence. */
      setPendingPlan({ status: 'error', message: error.message })
      setResult(error.message)
      setPendantStatus('Idle')
      setMessage(error.message?.startsWith('Blocked') ? 'Blocked for safety' : 'The phone could not think')
      announce(buildResultSpeech({ message: error.message, failed: true }))
    } finally {
      brainConfirmRef.current = null
      setBrainAsking(false)
      voiceOriginRef.current = false
      setIsExecuting(false)
    }
  }

  function openComposer(nextMessage = 'Type a command') {
    listeningModeRef.current = false
    setIsListening(false)
    setPendantStatus('Idle')
    setShowComposer(true)
    setMessage(nextMessage)
  }

  function stopVoiceRecognition({ intentional = false } = {}) {
    if (cloudVoiceRef.current) {
      try {
        cloudVoiceRef.current.cancel()
      } catch {
        // already stopped
      }
      cloudVoiceRef.current = null
    }

    if (!recognitionRef.current) {
      return
    }

    ignoreAbortRef.current = intentional
    try {
      recognitionRef.current.stop()
    } catch {
      // already stopped
    }
    recognitionRef.current = null
  }

  async function finishListeningAndThink() {
    const usingCloudVoice = Boolean(cloudVoiceRef.current)
    listeningModeRef.current = false

    if (usingCloudVoice) {
      const capture = cloudVoiceRef.current
      cloudVoiceRef.current = null
      setIsListening(false)
      setPendantStatus('Thinking...')
      setMessage('Transcribing…')

      try {
        const recorded = await capture.stop()
        const language = navigator.language?.startsWith('ko') ? 'ko' : 'en'
        const payload = await cloudClient.transcribeAudio({
          audioBase64: recorded.audioBase64,
          format: recorded.format,
          language,
        })
        const transcript = String(payload.text || '').trim()

        if (!transcript) {
          openComposer('Nothing captured. Type instead, or tap again to listen.')
          return
        }

        setCommand(transcript)
        setShowComposer(false)
        setMessage(transcript)
        setPendantStatus('Thinking...')
        voiceOriginRef.current = true
        runAgentFromCommand(transcript)
      } catch (error) {
        openComposer(
          error.message
            ? `Voice failed (${error.message}). Type instead.`
            : 'Voice failed. Type instead.',
        )
      }
      return
    }

    const transcript = transcriptRef.current.trim()
    stopVoiceRecognition({ intentional: true })
    setIsListening(false)

    if (!transcript) {
      openComposer('Nothing captured. Type instead, or tap again to listen.')
      return
    }

    setCommand(transcript)
    setShowComposer(false)
    setMessage('Thinking...')
    setPendantStatus('Thinking...')
    voiceOriginRef.current = true
    runAgentFromCommand(transcript)
  }

  async function startCloudListening() {
    clearTimers()
    setPendingPlan(null)
    setResult('')
    setShowComposer(false)
    transcriptRef.current = ''
    listeningModeRef.current = true
    stopVoiceRecognition({ intentional: true })

    try {
      const capture = await startCloudVoiceCapture()
      cloudVoiceRef.current = capture
      setPendantStatus('Listening...')
      setMessage('Listening… tap again when done')
      setIsListening(true)
    } catch (error) {
      listeningModeRef.current = false
      cloudVoiceRef.current = null

      if (/Permission|NotAllowed|denied/i.test(error.message || '')) {
        openComposer('Mic permission blocked. Type instead, or allow mic in browser settings.')
        return
      }

      openComposer(
        error.message
          ? `Voice could not start. Type instead. (${error.message})`
          : 'Voice could not start. Type instead.',
      )
    }
  }

  function startListening() {
    if (prefersCloudSpeechToText({ mode })) {
      startCloudListening()
      return
    }

    const SpeechRecognition =
      window.SpeechRecognition || window.webkitSpeechRecognition

    if (!SpeechRecognition) {
      // Desktop browsers without Web Speech can still use cloud STT in remote mode.
      if (mode === 'remote') {
        startCloudListening()
        return
      }
      openComposer('Voice is not available here. Type instead.')
      return
    }

    clearTimers()
    setPendingPlan(null)
    setResult('')
    setShowComposer(false)
    transcriptRef.current = ''
    listeningModeRef.current = true

    stopVoiceRecognition({ intentional: true })
    setPendantStatus('Listening...')
    setMessage('Listening… tap again when done')
    setIsListening(true)

    const recognition = new SpeechRecognition()
    recognitionRef.current = recognition
    recognition.lang = navigator.language?.startsWith('ko') ? 'ko-KR' : 'en-US'
    recognition.interimResults = true
    recognition.maxAlternatives = 1
    recognition.continuous = true

    recognition.onresult = (event) => {
      let finalChunk = ''
      let interimChunk = ''

      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index]
        const text = result[0]?.transcript ?? ''

        if (result.isFinal) {
          finalChunk += text
        } else {
          interimChunk += text
        }
      }

      if (finalChunk.trim()) {
        transcriptRef.current = `${transcriptRef.current} ${finalChunk}`.trim()
      }

      const livePreview = `${transcriptRef.current} ${interimChunk}`.trim()
      if (livePreview) {
        setMessage(livePreview)
      }
    }

    recognition.onerror = (event) => {
      if (event.error === 'aborted' && ignoreAbortRef.current) {
        ignoreAbortRef.current = false
        return
      }

      listeningModeRef.current = false
      setIsListening(false)
      setPendantStatus('Idle')

      if (event.error === 'no-speech') {
        openComposer('No speech detected. Type instead.')
        return
      }

      if (event.error === 'not-allowed') {
        openComposer('Mic permission blocked. Type instead, or allow mic in browser settings.')
        return
      }

      if (event.error === 'network') {
        // Cellular / carrier networks often break browser cloud STT.
        // Fall back to relay Whisper when remote settings are available.
        if (mode === 'remote' || cloudSettings.relayUrl) {
          setMessage('Browser voice blocked on this network. Switching…')
          startCloudListening()
          return
        }
        openComposer('Voice service unavailable (network). Type instead.')
        return
      }

      openComposer(`Voice failed (${event.error}). Type instead.`)
    }

    recognition.onend = () => {
      if (recognitionRef.current === recognition) {
        recognitionRef.current = null
      }

      // Browser may auto-stop continuous recognition; keep listening if user hasn't tapped again.
      if (listeningModeRef.current) {
        try {
          const next = new SpeechRecognition()
          recognitionRef.current = next
          next.lang = recognition.lang
          next.interimResults = true
          next.maxAlternatives = 1
          next.continuous = true
          next.onresult = recognition.onresult
          next.onerror = recognition.onerror
          next.onend = recognition.onend
          next.start()
        } catch {
          // If restart fails, wait for second tap with whatever we have.
        }
      }
    }

    try {
      recognition.start()
    } catch (error) {
      listeningModeRef.current = false
      openComposer(`Voice could not start. Type instead. (${error.message})`)
    }
  }

  function handlePendantTap() {
    /* The brain waiting on permission is "executing" — answering it is the
     * whole point of the tap, so this guard must not swallow it. */
    if (isExecuting && !brainAsking) {
      return
    }

    // Unlock iOS/Android audio during the tap gesture so later answers can play.
    void unlockSpeechAudio()

    if (isListening || listeningModeRef.current) {
      finishListeningAndThink()
      return
    }

    // Voice-first confirm: tap pendant again when a plan is ready.
    if (pendingPlan && pendingPlan.status !== 'error') {
      handleConfirm()
      return
    }

    startListening()
  }

  function handleComposerSubmit(event) {
    event.preventDefault()
    const nextCommand = command.trim()

    if (!nextCommand) {
      setMessage('Type a command first.')
      return
    }

    setShowComposer(false)
    voiceOriginRef.current = false
    runAgentFromCommand(nextCommand)
  }

  function applySessionFromPlan(payload) {
    if (!payload?.sessionId) {
      return
    }

    rememberDashboardSession({ sessionId: payload.sessionId })
    fetchSessions()
  }

  function handleInstantPlan(payload) {
    applySessionFromPlan(payload)
    const nextResult = payload.response ?? payload.summary ?? 'Done'
    setResult(nextResult)
    setPendingPlan(null)
    setPendantStatus('Done')
    setMessage(
      payload.builtin
        ? `${payload.builtin} builtin completed instantly`
        : 'Instant response ready',
    )
    upsertLocalSession({
      sessionId: payload.sessionId,
      title: command,
      updatedAt: new Date().toISOString(),
      turns: [
        { role: 'user', content: command, source: 'user' },
        {
          role: 'assistant',
          content: payload.response ?? payload.summary,
          source: payload.builtin ?? 'builtin',
          result: payload.response,
        },
      ],
    })
    setSessions(loadLocalSessions())
    announce(
      buildResultSpeech({
        result: nextResult,
        message: payload.response ?? payload.summary,
      }),
    )
    voiceOriginRef.current = false
  }

  function preparePlan(plan, executionMode, remotePlanJobId = null) {
    if (plan.status === 'instant') {
      handleInstantPlan(plan)
      return
    }

    const nextPlan = {
      ...plan,
      executionMode,
      remotePlanJobId,
      sessionId: plan.sessionId ?? activeSessionId,
    }
    setPendingPlan(nextPlan)

    if (plan.status === 'error') {
      setPendantStatus('Idle')
      setMessage(plan.message)
      announce(buildResultSpeech({ message: plan.message, failed: true }))
      voiceOriginRef.current = false
      return
    }

    setPendantStatus('Ready')
    setMessage(
      voiceOriginRef.current
        ? 'Ready — tap pendant to confirm'
        : 'Ready for confirmation',
    )
    // Voice path: keep confirm cue short so the real answer can speak sooner.
    announce(voiceOriginRef.current ? 'Ready.' : buildPlanSpeech(nextPlan))
  }

  async function requestRemotePlan(commandToRun) {
    try {
      const job = await cloudClient.requestPlan(commandToRun, activeSessionId)

      if (job.status === 'failed') {
        throw new Error(job.error ?? 'Remote planning failed.')
      }

      const planPayload = job.result ?? job

      if (planPayload.status === 'instant') {
        handleInstantPlan(planPayload)
      } else {
        preparePlan(normalizeMacPlan(planPayload), 'remote', job.jobId)
      }
      setRemoteStatus('Connected')
      setRemoteHealth((current) => ({
        ...(current ?? {}),
        macBridgeOnline: true,
      }))
    } catch (error) {
      setPendingPlan({
        status: 'error',
        message:
          error.message ||
          'Cloud relay is not connected. Start relay and home Mac bridge.',
      })
      setPendantStatus('Idle')
      setMessage(error.message?.startsWith('Blocked') ? 'Blocked for safety' : 'Plan failed')
      announce(
        buildResultSpeech({
          message: error.message || 'Plan failed',
          failed: true,
        }),
      )
      voiceOriginRef.current = false
    }
  }

  async function requestMacPlan(commandToRun) {
    try {
      const response = await fetch(`${macAgentUrl}/plan`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders(agentToken),
        },
        body: JSON.stringify({
          command: commandToRun,
          sessionId: activeSessionId || undefined,
        }),
      })
      const payload = await response.json()

      if (!response.ok) {
        throw new Error(payload.error ?? 'Mac agent could not plan this command.')
      }

      if (payload.status === 'instant') {
        handleInstantPlan(payload)
      } else {
        preparePlan(normalizeMacPlan(payload), 'mac')
      }
      setMacStatus('Connected')
    } catch (error) {
      setPendingPlan({
        status: 'error',
        message:
          error.message ||
          'Mac agent is not connected. Please start the local agent on your Mac.',
      })
      setPendantStatus('Idle')
      setMessage(error.message?.startsWith('Blocked') ? 'Blocked for safety' : 'Plan failed')
      announce(
        buildResultSpeech({
          message: error.message || 'Plan failed',
          failed: true,
        }),
      )
      voiceOriginRef.current = false
    }
  }

  async function handleConfirm() {
    if (!pendingPlan || pendingPlan.status === 'error') {
      return
    }

    /* The brain is mid-loop and waiting on this answer, so `isExecuting` is
     * true by design here — checking it before this branch would deadlock the
     * one gate the model asked for. */
    if (brainConfirmRef.current) {
      const resolve = brainConfirmRef.current
      brainConfirmRef.current = null
      stopSpeaking()
      setBrainAsking(false)
      setPendingPlan(null)
      setPendantStatus('Working...')
      setMessage('Going ahead.')
      resolve(true)
      return
    }

    if (isExecuting) {
      return
    }

    stopSpeaking()
    setIsExecuting(true)
    setPendantStatus('Thinking...')
    setMessage('Running on your Mac…')

    try {
      if (pendingPlan.executionMode === 'remote') {
        await executeRemotePlan()
        return
      }

      if (pendingPlan.executionMode === 'mac') {
        await executeMacPlan()
        return
      }

      const mockResult = executePlan(pendingPlan, simulatorState, command)
      setSimulatorState(mockResult.state)
      setResult(mockResult.response.body)
      setPendingPlan(null)
      setPendantStatus('Done')
      setMessage('Done')
      announce(buildResultSpeech({ result: mockResult.response.body }))
      voiceOriginRef.current = false
    } finally {
      setIsExecuting(false)
    }
  }

  async function executeRemotePlan() {
    try {
      setPendantStatus('Thinking...')
      setMessage('Working on your home Mac via cloud...')
      const job = await cloudClient.executePlan({
        command,
        actions: pendingPlan.rawActions,
        planJobId: pendingPlan.remotePlanJobId,
        sessionId: pendingPlan.sessionId ?? activeSessionId ?? undefined,
      })

      if (job.status === 'failed') {
        throw new Error(job.error ?? 'Remote execution failed.')
      }

      const payload = job.result ?? {}
      const nextResult = Array.isArray(payload.results)
        ? payload.results.map((item) => truncateResult(item.message)).join(' ')
        : job.error || 'Remote action completed.'
      // Speak immediately when the Mac finishes — before extra UI bookkeeping.
      announce(buildResultSpeech({ result: nextResult }))
      setResult(nextResult)
      setMacLogs(payload.logs ?? [])
      setContextGraph(payload.contextGraph ?? null)
      setPendingPlan(null)
      setPendantStatus('Done')
      setMessage('Done')
      setRemoteStatus('Connected')
      voiceOriginRef.current = false
    } catch (error) {
      announce(
        buildResultSpeech({
          message: error.message || 'Action failed',
          failed: true,
        }),
      )
      setResult(error.message)
      setPendantStatus('Idle')
      setMessage(error.message?.startsWith('Blocked') ? 'Blocked for safety' : 'Action failed')
      voiceOriginRef.current = false
    }
  }

  async function executeMacPlan() {
    try {
      setPendantStatus('Thinking...')
      setMessage('Working on your Mac...')
      const response = await fetch(`${macAgentUrl}/execute`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders(agentToken),
        },
        body: JSON.stringify({
          command,
          actions: pendingPlan.rawActions,
          sessionId: pendingPlan.sessionId ?? activeSessionId ?? undefined,
        }),
      })
      const payload = await response.json()

      if (!response.ok) {
        throw new Error(payload.error ?? 'Mac execution failed.')
      }

      const nextResult = payload.results
        .map((item) => truncateResult(item.message))
        .join(' ')
      announce(buildResultSpeech({ result: nextResult }))
      setResult(nextResult)
      setMacLogs(payload.logs ?? [])
      setContextGraph(payload.contextGraph ?? null)
      setPendingPlan(null)
      setPendantStatus('Done')
      setMessage('Done')
      setMacStatus('Connected')
      voiceOriginRef.current = false
    } catch (error) {
      announce(
        buildResultSpeech({
          message: error.message || 'Action failed',
          failed: true,
        }),
      )
      setResult(error.message)
      setPendantStatus('Idle')
      setMessage(error.message?.startsWith('Blocked') ? 'Blocked for safety' : 'Action failed')
      voiceOriginRef.current = false
    }
  }

  function handleCancel() {
    stopSpeaking()

    /* Declining the brain is not the same as cancelling a plan: the loop keeps
     * running, is told it was refused, and gets to do the part the owner DID
     * ask for. Killing the turn here would punish it for asking. */
    if (brainConfirmRef.current) {
      const resolve = brainConfirmRef.current
      brainConfirmRef.current = null
      setBrainAsking(false)
      setPendingPlan(null)
      setPendantStatus('Thinking...')
      setMessage('No — carrying on without that.')
      resolve(false)
      return
    }

    setPendingPlan(null)
    setResult('')
    setPendantStatus('Idle')
    setMessage('Cancelled')
    announce('Cancelled.')
    voiceOriginRef.current = false
  }

  function handleSaveCloudSettings() {
    saveCloudSettings(cloudSettings)
    setMessage('Cloud relay settings saved')
    checkRemoteRelay()
  }

  function handleSaveAgentSettings() {
    localStorage.setItem('macAgentUrl', macAgentUrl)
    localStorage.setItem('macAgentToken', agentToken)
    setMessage('Agent settings saved')
    checkMacAgent()
  }

  function handleAdvancedToggle(event) {
    const isOpen = event.currentTarget.open
    setIsAdvancedOpen(isOpen)

    if (isOpen) {
      fetchContextGraph().catch(() => {})
    }
  }

  function handleResetDemoData() {
    localStorage.removeItem('aiPendantSimulator')
    const freshState = loadSimulatorState()
    setSimulatorState({
      ...freshState,
      calendar: simulatorState.calendar,
    })
    setMacLogs([])
    setContextGraph(null)
    setPendingPlan(null)
    setResult('')
    setPendantStatus('Idle')
    setMessage('Demo data reset')
  }

  async function handleResetContextGraph() {
    try {
      const response = await fetch(`${macAgentUrl}/context-graph/reset`, {
        method: 'POST',
        headers: authHeaders(agentToken),
      })
      const payload = await response.json()

      if (!response.ok) {
        throw new Error(payload.error ?? 'Context graph reset failed.')
      }

      setContextGraph(payload.graph)
      setMessage('Context graph reset')
    } catch (error) {
      setMessage(error.message ?? 'Context graph reset failed')
    }
  }

  async function handleLoadDemoContextGraph() {
    try {
      const response = await fetch(`${macAgentUrl}/context-graph/demo`, {
        method: 'POST',
        headers: authHeaders(agentToken),
      })
      const payload = await response.json()

      if (!response.ok) {
        throw new Error(payload.error ?? 'Demo context graph could not be loaded.')
      }

      setContextGraph(payload.graph)
      setMessage('Demo context graph loaded')
    } catch (error) {
      setMessage(error.message ?? 'Demo context graph failed')
    }
  }

  function handleExportDemoLog() {
    const payload = {
      exportedAt: new Date().toISOString(),
      macLogs,
      mockActivityLog: simulatorState.activityLog,
      drafts: simulatorState.drafts,
      reminders: simulatorState.reminders,
      contextGraph,
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: 'application/json',
    })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = 'ai-pendant-demo-log.json'
    link.click()
    URL.revokeObjectURL(url)
    setMessage('Demo log exported')
  }

  return (
    <main className="app-shell pendant-app">
      <section className="pendant-stage" aria-label="AI Pendant">
        <p className="brand-mark">AI Pendant</p>

        <button
          className={`pendant ${getPendantClass(pendantStatus)} ${isListening ? 'is-listening' : ''}`}
          type="button"
          onClick={handlePendantTap}
          onDoubleClick={(event) => {
            event.preventDefault()
            listeningModeRef.current = false
            stopVoiceRecognition({ intentional: true })
            openComposer('Type a command')
          }}
          onContextMenu={(event) => {
            event.preventDefault()
            setShowSettings(true)
          }}
          aria-label={
            isListening
              ? 'Tap again to finish and think'
              : 'Tap pendant to start listening'
          }
          aria-pressed={isListening}
        >
          <span className="led-ring"></span>
          <span className="center-button">
            <span className="mic-dot"></span>
          </span>
        </button>

        <p className={`connection-dot ${isConnected ? 'online' : 'offline'}`}>
          {isConnected ? 'Connected' : 'Disconnected'}
        </p>

        <p className="status-whisper">
          {isListening
            ? 'Listening… tap again to think'
            : pendingPlan && pendingPlan.status !== 'error'
              ? 'Tap pendant to confirm'
              : pendantStatus === 'Thinking...'
                ? 'Thinking…'
                : pendantStatus === 'Done'
                  ? result || 'Done'
                  : message || 'Tap to listen'}
        </p>

        {showComposer ? (
          <form className="composer-overlay" onSubmit={handleComposerSubmit}>
            <textarea
              value={command}
              onChange={(event) => setCommand(event.target.value)}
              placeholder="Create a note on my Desktop called pendant demo..."
              rows={3}
              autoFocus
            />
            <div className="confirmation-row">
              <button className="primary-button" type="submit">
                Run
              </button>
              <button
                className="secondary-button"
                type="button"
                onClick={() => setShowComposer(false)}
              >
                Close
              </button>
            </div>
            <div className="composer-suggestions">
              {[
                'What time is it?',
                'Weather in Chicago',
                'Create a note on my Desktop called pendant demo.',
                'Take a screenshot and save it to my Desktop.',
              ].map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  onClick={() => {
                    setCommand(suggestion)
                    setShowComposer(false)
                    runAgentFromCommand(suggestion)
                  }}
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </form>
        ) : null}

        {pendingPlan && pendingPlan.status !== 'error' ? (
          <div className={`plan-card ${isExecuting && !brainAsking ? 'is-running' : ''}`}>
            <div className="plan-card-glow" />
            <p className="plan-kicker">
              {brainAsking ? 'Asking' : isExecuting ? 'Running' : 'Ready'}
            </p>
            <h3 className="plan-title">
              {brainAsking
                ? /* The model's own sentence, addressed to the owner — the
                   * reason it wants to go beyond what they asked for. */
                  pendingPlan.summary
                : isExecuting
                  ? mode === 'brain'
                    ? 'Working…'
                    : 'Working on your Mac…'
                  : 'Confirm this plan'}
            </h3>
            <ol className="plan-steps">
              {(pendingPlan.actions ?? []).map((action, index) => (
                <li key={`${action.type}-${index}`}>
                  <span className="plan-step-index">{index + 1}</span>
                  <div>
                    <strong>{actionLabel(action)}</strong>
                    <span>{describeAction(action)}</span>
                  </div>
                </li>
              ))}
            </ol>
            <div className="confirmation-row">
              <button
                className="primary-button"
                type="button"
                disabled={isExecuting && !brainAsking}
                onClick={handleConfirm}
              >
                {brainAsking ? 'Go ahead' : isExecuting ? 'Running…' : 'Confirm'}
              </button>
              <button
                className="secondary-button"
                type="button"
                disabled={isExecuting && !brainAsking}
                onClick={handleCancel}
              >
                {/* Not "Cancel": declining does not end the turn, it tells the
                    model no and lets it finish what was actually asked. */}
                {brainAsking ? 'No thanks' : 'Cancel'}
              </button>
            </div>
          </div>
        ) : null}

        {pendingPlan?.status === 'error' ? (
          <p className="error-whisper">{pendingPlan.message}</p>
        ) : null}

        <button
          className="settings-orb"
          type="button"
          aria-label="Open settings"
          onClick={() => setShowSettings((current) => !current)}
        />
      </section>

      {showSettings ? (
        <section className="settings-sheet" aria-label="Settings">
          <header>
            <h2>Settings</h2>
            <button className="ghost-button" type="button" onClick={() => setShowSettings(false)}>
              Close
            </button>
          </header>

          <label htmlFor="mac-agent-url">Mac Agent URL</label>
          <input
            id="mac-agent-url"
            value={macAgentUrl}
            onChange={(event) => setMacAgentUrl(event.target.value)}
          />
          <label htmlFor="agent-token">Agent Token</label>
          <input
            id="agent-token"
            type="password"
            value={agentToken}
            onChange={(event) => setAgentToken(event.target.value)}
          />
          <div className="advanced-actions">
            <button className="ghost-button" type="button" onClick={handleSaveAgentSettings}>
              Save & Connect
            </button>
            <button className="ghost-button" type="button" onClick={checkMacAgent}>
              Test
            </button>
          </div>

          <label htmlFor="typed-command">Or type a command</label>
          <textarea
            id="typed-command"
            value={command}
            onChange={(event) => setCommand(event.target.value)}
            rows={2}
          />
          <button className="primary-button" type="button" onClick={handleRunAgent}>
            Run typed command
          </button>

          <details
            className="advanced-panel"
            open={isAdvancedOpen}
            onToggle={handleAdvancedToggle}
          >
            <summary>Developer</summary>

            <div className="mode-toggle">
              <button
                className={mode === 'brain' ? 'is-selected' : ''}
                type="button"
                onClick={() => handleModeChange('brain')}
                title="The phone reasons and acts on its own. Works with the Mac asleep."
              >
                Phone Brain
              </button>
              <button
                className={mode === 'mac' ? 'is-selected' : ''}
                type="button"
                onClick={() => handleModeChange('mac')}
              >
                Local Mac
              </button>
              <button
                className={mode === 'remote' ? 'is-selected' : ''}
                type="button"
                onClick={() => handleModeChange('remote')}
              >
                Remote Cloud
              </button>
              <button
                className={mode === 'mock' ? 'is-selected' : ''}
                type="button"
                onClick={() => handleModeChange('mock')}
              >
                Mock
              </button>
            </div>

            <label htmlFor="relay-url">Relay URL</label>
            <input
              id="relay-url"
              value={cloudSettings.relayUrl}
              onChange={(event) =>
                setCloudSettings((current) => ({
                  ...current,
                  relayUrl: event.target.value,
                }))
              }
            />
            <label htmlFor="relay-pairing-code">One-time pairing code</label>
            <input
              id="relay-pairing-code"
              type="password"
              autoComplete="one-time-code"
              value={cloudSettings.pairingCode}
              onChange={(event) =>
                setCloudSettings((current) => ({
                  ...current,
                  pairingCode: event.target.value,
                }))
              }
            />
            <div className="advanced-actions">
              <button className="ghost-button" type="button" onClick={handleSaveCloudSettings}>
                Save Cloud
              </button>
              <button
                className="ghost-button"
                type="button"
                onClick={() => {
                  setShowDashboard((current) => !current)
                  fetchSessions()
                }}
              >
                {showDashboard ? 'Hide Dashboard' : 'Dashboard'}
              </button>
            </div>

            {showDashboard ? (
              <DashboardPanel
                sessions={sessions}
                activeSessionId={activeSessionId}
                onSelectSession={(sessionId) => {
                  setActiveSessionId(sessionId)
                  rememberDashboardSession({ sessionId })
                }}
                onNewSession={async () => {
                  if (mode === 'remote') {
                    const sessionId = crypto.randomUUID()
                    try {
                      const productState =
                        await cloudClient.createProductSession({
                          sessionId,
                          title: 'New session',
                        })
                      setActiveSessionId(sessionId)
                      rememberDashboardSession({ sessionId })
                      setSessions(
                        (productState?.sessions ?? []).filter(
                          (session) => !session.deletedAt,
                        ),
                      )
                    } catch (error) {
                      setMessage(
                        error.message || 'Shared session could not be created.',
                      )
                    }
                    return
                  }

                  if (mode === 'mac') {
                    const response = await fetch(`${macAgentUrl}/sessions`, {
                      method: 'POST',
                      headers: {
                        'Content-Type': 'application/json',
                        ...authHeaders(agentToken),
                      },
                      body: JSON.stringify({ title: 'New session' }),
                    })
                    const payload = await response.json()

                    if (response.ok) {
                      setActiveSessionId(payload.session.sessionId)
                      rememberDashboardSession({
                        sessionId: payload.session.sessionId,
                      })
                      fetchSessions()
                      return
                    }
                  }

                  const localId = crypto.randomUUID()
                  setActiveSessionId(localId)
                  rememberDashboardSession({ sessionId: localId })
                  upsertLocalSession({
                    sessionId: localId,
                    title: 'New session',
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                    turns: [],
                  })
                  setSessions(loadLocalSessions())
                }}
                onRefresh={fetchSessions}
              />
            ) : null}

            <h3>Examples</h3>
            <div className="example-row">
              {advancedExamples.map((example) => (
                <button
                  key={example}
                  type="button"
                  onClick={() => setCommand(example)}
                >
                  {example}
                </button>
              ))}
            </div>

            <pre>{rawPlan || 'No pending plan.'}</pre>
            <ContextGraphSummary graph={contextGraph} />
            <div className="advanced-actions">
              <button className="ghost-button" type="button" onClick={handleExportDemoLog}>
                Export Demo Log
              </button>
              <button className="ghost-button" type="button" onClick={handleResetDemoData}>
                Reset Demo Data
              </button>
              <button className="ghost-button" type="button" onClick={fetchContextGraph}>
                Refresh Context Graph
              </button>
              <button className="ghost-button" type="button" onClick={handleLoadDemoContextGraph}>
                Load Demo Graph
              </button>
              <button className="ghost-button" type="button" onClick={handleResetContextGraph}>
                Reset Context Graph
              </button>
            </div>
          </details>
        </section>
      ) : null}
    </main>
  )
}

function ContextGraphSummary({ graph }) {
  const [selectedEntityId, setSelectedEntityId] = useState(null)
  const [expansionStep, setExpansionStep] = useState(null)
  const expansionTimers = useRef([])

  useEffect(() => {
    return () => {
      expansionTimers.current.forEach((timer) => window.clearTimeout(timer))
    }
  }, [])

  if (!graph) {
    return <p>No context graph loaded yet.</p>
  }

  const entities = graph.entities ?? []
  const relations = graph.relations ?? []
  const recentEntities = entities.slice(-8).reverse()
  const recentRelations = relations.slice(-8).reverse()
  const entityById = new Map(graph.entities?.map((entity) => [entity.id, entity]) ?? [])
  const layout = buildGraphLayout(entities)
  const expansionOrder = buildExpansionOrder(entities)
  const visibleEntityIds =
    expansionStep === null
      ? new Set(entities.map((entity) => entity.id))
      : new Set(expansionOrder.slice(0, expansionStep + 1).map((entity) => entity.id))
  const visibleRelations = relations
    .filter(
      (relation) =>
        layout.has(relation.from) &&
        layout.has(relation.to) &&
        visibleEntityIds.has(relation.from) &&
        visibleEntityIds.has(relation.to),
    )
    .slice(-18)
  const selectedEntity = entityById.get(selectedEntityId) ?? entities[0] ?? null
  const selectedRelations = selectedEntity
    ? relations.filter(
        (relation) =>
          relation.from === selectedEntity.id || relation.to === selectedEntity.id,
      )
    : []
  const isExpanding = expansionStep !== null && expansionStep < expansionOrder.length - 1

  function playExpansionDemo() {
    expansionTimers.current.forEach((timer) => window.clearTimeout(timer))
    expansionTimers.current = []
    setSelectedEntityId(null)
    setExpansionStep(0)

    expansionOrder.forEach((entity, index) => {
      const timer = window.setTimeout(() => {
        setExpansionStep(index)
        setSelectedEntityId(entity.id)
      }, index * 520)
      expansionTimers.current.push(timer)
    })
  }

  function showFullGraph() {
    expansionTimers.current.forEach((timer) => window.clearTimeout(timer))
    expansionTimers.current = []
    setExpansionStep(null)
  }

  return (
    <div className="context-graph-summary">
      <p>
        Entities: {entities.length} · Relations: {relations.length}
      </p>
      <div className="ontology-explorer" aria-label="Ontology graph explorer">
        <div className="ontology-toolbar">
          <div>
            <strong>Pendant Context Graph</strong>
            <span>Obsidian-style ontology map</span>
          </div>
          <div className="ontology-controls">
            <div className="ontology-legend" aria-label="Entity type legend">
              <i className="project"></i>Project
              <i className="emaildraft"></i>Email
              <i className="resource"></i>Resource
              <i className="task"></i>Task
            </div>
            <button type="button" onClick={playExpansionDemo}>
              {isExpanding ? 'Replaying...' : 'Play Expansion'}
            </button>
            {expansionStep !== null ? (
              <button type="button" onClick={showFullGraph}>
                Show Full
              </button>
            ) : null}
          </div>
        </div>
        {entities.length ? (
          <div className="ontology-canvas">
            <svg viewBox="0 0 920 500" role="img" aria-label="Context graph nodes and relations">
            <defs>
              <filter id="nodeGlow" x="-60%" y="-60%" width="220%" height="220%">
                <feGaussianBlur stdDeviation="4" result="blur" />
                <feMerge>
                  <feMergeNode in="blur" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
            </defs>
            {visibleRelations.map((relation) => {
              const from = layout.get(relation.from)
              const to = layout.get(relation.to)
              const midX = (from.x + to.x) / 2
              const midY = (from.y + to.y) / 2
              const isSelected =
                relation.from === selectedEntity?.id || relation.to === selectedEntity?.id
              const curve = Math.abs(from.y - to.y) > 120 ? 36 : -20

              return (
                <g
                  key={relation.id}
                  className={`graph-edge ${isSelected ? 'is-selected' : ''}`}
                >
                  <path
                    d={`M ${from.x} ${from.y} Q ${midX} ${midY + curve} ${to.x} ${to.y}`}
                  />
                  {isSelected || isPrimaryRelation(relation.type) ? (
                    <text x={midX} y={midY + curve - 4}>{relation.type}</text>
                  ) : null}
                </g>
              )
            })}
            {entities.map((entity) => {
              if (!visibleEntityIds.has(entity.id)) {
                return null
              }

              const point = layout.get(entity.id)

              if (!point) {
                return null
              }

              return (
                <g
                  className={`graph-node ${entity.type.toLowerCase()} ${
                    entity.id === selectedEntity?.id ? 'is-selected' : ''
                  }`}
                  key={entity.id}
                  transform={`translate(${point.x} ${point.y})`}
                  role="button"
                  tabIndex="0"
                  onClick={() => setSelectedEntityId(entity.id)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      setSelectedEntityId(entity.id)
                    }
                  }}
                >
                  <circle r={point.radius} />
                  <text className="node-label" x={point.labelX} y={point.labelY}>
                    {entity.name}
                  </text>
                  <text className="node-type" x={point.labelX} y={point.labelY + 14}>
                    {entity.type}
                  </text>
                </g>
              )
            })}
            </svg>
            {expansionStep !== null ? (
              <div className="expansion-status">
                <strong>
                  {expansionStep + 1}/{expansionOrder.length}
                </strong>
                <span>
                  Revealing {expansionOrder[expansionStep]?.type}:{' '}
                  {expansionOrder[expansionStep]?.name}
                </span>
              </div>
            ) : null}
            <aside className="graph-inspector">
              {selectedEntity ? (
                <>
                  <span className={`type-pill ${selectedEntity.type.toLowerCase()}`}>
                    {selectedEntity.type}
                  </span>
                  <strong>{selectedEntity.name}</strong>
                  <p>{describeEntity(selectedEntity)}</p>
                  <small>{selectedRelations.length} linked relation{selectedRelations.length === 1 ? '' : 's'}</small>
                </>
              ) : null}
            </aside>
          </div>
        ) : (
          <div className="empty-graph">
            Run an action or click Load Demo Graph.
          </div>
        )}
      </div>
      <div className="context-graph-grid">
        <div>
          <strong>Recent entities</strong>
          {recentEntities.length ? (
            recentEntities.map((entity) => (
              <span key={entity.id}>
                {entity.type}: {entity.name}
              </span>
            ))
          ) : (
            <span>None</span>
          )}
        </div>
        <div>
          <strong>Recent relations</strong>
          {recentRelations.length ? (
            recentRelations.map((relation) => (
              <span key={relation.id}>
                {entityLabel(entityById.get(relation.from))} {relation.type}{' '}
                {entityLabel(entityById.get(relation.to))}
              </span>
            ))
          ) : (
            <span>None</span>
          )}
        </div>
      </div>
    </div>
  )
}

function entityLabel(entity) {
  if (!entity) {
    return 'Unknown'
  }

  return `${entity.type}:${entity.name}`
}

function isPrimaryRelation(type) {
  return ['about', 'sent_to', 'follows_up', 'related_to'].includes(type)
}

function describeEntity(entity) {
  if (entity.type === 'EmailDraft') {
    return `Draft to ${entity.attributes?.to ?? 'someone'} about ${
      entity.attributes?.subject ?? entity.name
    }.`
  }

  if (entity.type === 'Task') {
    return `Follow-up task${entity.attributes?.due ? ` due ${entity.attributes.due}` : ''}.`
  }

  if (entity.type === 'Resource') {
    return 'A topic or resource the assistant can reference in later commands.'
  }

  if (entity.type === 'Project') {
    return 'The central project context that related tasks and resources connect to.'
  }

  return 'Context entity stored by the Mac local agent.'
}

function buildExpansionOrder(entities) {
  const typePriority = {
    Project: 0,
    Resource: 1,
    EmailDraft: 2,
    Person: 3,
    Task: 4,
    File: 5,
    Action: 6,
    Tool: 7,
    Device: 8,
    Model: 9,
  }

  return [...entities].sort((a, b) => {
    const priorityDelta =
      (typePriority[a.type] ?? 99) - (typePriority[b.type] ?? 99)

    if (priorityDelta !== 0) {
      return priorityDelta
    }

    return a.name.localeCompare(b.name)
  })
}

function buildGraphLayout(entities) {
  const anchors = {
    Project: { x: 470, y: 240, labelX: 22, labelY: 3 },
    Resource: { x: 595, y: 128, labelX: 18, labelY: -8 },
    EmailDraft: { x: 710, y: 220, labelX: 20, labelY: 0 },
    Person: { x: 802, y: 146, labelX: 16, labelY: 3 },
    Task: { x: 648, y: 348, labelX: 18, labelY: 4 },
    File: { x: 472, y: 390, labelX: -132, labelY: 4 },
    Action: { x: 330, y: 315, labelX: -172, labelY: 4 },
    Tool: { x: 230, y: 250, labelX: -128, labelY: 4 },
    Device: { x: 150, y: 170, labelX: -112, labelY: 4 },
    Model: { x: 292, y: 130, labelX: -148, labelY: 4 },
  }
  const radii = {
    Project: 18,
    EmailDraft: 15,
    Person: 13,
    Resource: 13,
    Task: 14,
    File: 11,
    Action: 13,
    Tool: 10,
    Device: 11,
    Model: 11,
  }
  const groups = new Map()

  entities.forEach((entity) => {
    const group = groups.get(entity.type) ?? []
    group.push(entity)
    groups.set(entity.type, group)
  })

  const points = new Map()

  Array.from(groups.entries()).forEach(([type, group]) => {
    const anchor = anchors[type] ?? { x: 470, y: 240, labelX: 18, labelY: 4 }

    group.forEach((entity, index) => {
      const offset = index - (group.length - 1) / 2
      const column = index % 2 === 0 ? -1 : 1

      points.set(entity.id, {
        x: anchor.x + column * Math.abs(offset) * 22,
        y: anchor.y + offset * 44,
        radius: radii[type] ?? 24,
        labelX: anchor.labelX,
        labelY: anchor.labelY,
      })
    })
  })

  return points
}

function actionLabel(action) {
  const type = action.type ?? action.tool
  const labels = {
    open_app: 'App',
    open_url: 'Browser',
    open_path: 'Open',
    open_folder: 'Folder',
    write_file: 'Write',
    read_file: 'Read',
    create_note: 'Note',
    search_file: 'Search',
    run_shell: 'Terminal',
    copy_to_clipboard: 'Clipboard',
    screenshot: 'Screenshot',
    send_email: 'Email',
  }
  return action.label?.split('(')[0]?.trim() || labels[type] || type
}

function describeAction(action) {
  const type = action.type ?? action.tool
  const params = action.params ?? action.parameters ?? {}

  if (type === 'open_url' && params.url?.includes('mail.google.com')) {
    return 'open Gmail on your Mac'
  }

  if (type === 'open_url') {
    return `open ${params.url} on your Mac`
  }

  if (type === 'open_app') {
    return `open ${params.appName} on your Mac`
  }

  if (type === 'open_folder') {
    return 'open the project folder on your Mac'
  }

  if (type === 'create_note') {
    return `create ${params.filename}`
  }

  if (type === 'copy_to_clipboard') {
    return 'copy the draft to your Mac clipboard'
  }

  if (type === 'run_project') {
    return 'run the AI pendant project'
  }

  if (type === 'search_file') {
    return `search for ${params.query}`
  }

  if (type === 'draft_email') {
    return `draft an email to ${params.to}`
  }

  if (type === 'create_reminder') {
    return `create a reminder for ${params.title}`
  }

  if (type === 'run_shell') {
    return `run shell command: ${truncate(params.command, 60)}`
  }

  if (type === 'run_applescript') {
    return 'run AppleScript automation on your Mac'
  }

  if (type === 'open_path') {
    return `open ${params.path}`
  }

  if (type === 'write_file') {
    return `write file ${params.path}`
  }

  if (type === 'read_file') {
    return `read file ${params.path}`
  }

  if (type === 'list_directory') {
    return `list files in ${params.path || 'folder'}`
  }

  if (type === 'delete_path') {
    return `delete ${params.path}`
  }

  if (type === 'copy_path') {
    return `copy ${params.from} to ${params.to}`
  }

  if (type === 'move_path') {
    return `move ${params.from} to ${params.to}`
  }

  if (type === 'type_text') {
    return 'type text into the active app'
  }

  if (type === 'press_keys') {
    return `press ${params.keys}`
  }

  if (type === 'send_email') {
    return params.send === false
      ? `draft email to ${params.to}`
      : `send email to ${params.to}`
  }

  if (type === 'screenshot') {
    return 'take a screenshot'
  }

  if (type === 'get_clipboard') {
    return 'read the clipboard'
  }

  if (type === 'check_calendar') {
    return `check your calendar for ${params.date}`
  }

  return action.label ?? action.summary ?? type
}

function truncate(value, maxLength) {
  const text = String(value ?? '')

  if (text.length <= maxLength) {
    return text
  }

  return `${text.slice(0, maxLength - 3)}...`
}

function normalizeMacPlan(plan) {
  return {
    status: 'ready',
    mode: 'mac_control',
    action: 'Prepare Mac actions',
    tool:
      plan.actions.length > 1
        ? `${plan.actions.length} Mac actions`
        : plan.actions[0].type,
    summary:
      plan.actions.length > 1
        ? `${plan.actions.length} Mac actions prepared`
        : plan.actions[0].label,
    actions: plan.actions,
    rawActions: plan.actions,
    requiresConfirmation: plan.requiresConfirmation,
    parameters: plan.actions.map((action, index) => ({
      step: index + 1,
      type: action.type,
      params: action.params,
    })),
  }
}

function getPendantClass(status) {
  return status.toLowerCase().replace(/\W+/g, '-')
}

function isLocalHost() {
  const hostname = window.location.hostname || 'localhost'
  return hostname === 'localhost' || hostname === '127.0.0.1'
}

function getDefaultConnectionMode() {
  /*
   * On the actual phone, the phone's own brain is the default.
   *
   * Capacitor serves bundled assets from localhost, but a phone does not host
   * the Mac agent, so native clients have always started through the relay —
   * and 'remote' means "the Mac does the thinking", which is exactly the
   * arrangement that leaves the phone useless with the lid shut. 'brain' talks
   * to the same relay with the same credential; the difference is who reasons.
   * The Mac is still reachable from it, as a tool.
   */
  if (isNativeCredentialStorage()) {
    return 'brain'
  }

  return isLocalHost() ? 'mac' : 'remote'
}

function getDefaultMacAgentUrl() {
  return 'http://localhost:8000'
}

function loadSavedAgentUrl() {
  return localStorage.getItem('macAgentUrl') || getDefaultMacAgentUrl()
}

function loadSavedAgentToken() {
  return localStorage.getItem('macAgentToken') || ''
}

function authHeaders(token) {
  return token ? { Authorization: `Bearer ${token}` } : {}
}

function truncateResult(value, maxLength = 180) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()

  if (text.length <= maxLength) {
    return text
  }

  return `${text.slice(0, maxLength - 3)}...`
}

export default App
