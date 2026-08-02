export function prefersCloudSpeechToText({ mode } = {}) {
  if (mode === 'remote') {
    return true
  }

  return /iPhone|iPad|iPod|Android/i.test(navigator.userAgent || '')
}

export function pickRecorderMimeType() {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
    'audio/ogg;codecs=opus',
    'audio/ogg',
  ]

  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) {
    return ''
  }

  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || ''
}

export async function startCloudVoiceCapture() {
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    throw new Error('This browser cannot record microphone audio.')
  }

  const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  const mimeType = pickRecorderMimeType()
  const recorder = mimeType
    ? new MediaRecorder(stream, { mimeType })
    : new MediaRecorder(stream)
  const chunks = []

  recorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) {
      chunks.push(event.data)
    }
  }

  const stopped = new Promise((resolve, reject) => {
    recorder.onerror = () => {
      reject(new Error('Microphone recording failed.'))
    }
    recorder.onstop = () => {
      resolve()
    }
  })

  recorder.start(250)

  return {
    mimeType: recorder.mimeType || mimeType || 'audio/webm',
    async stop() {
      if (recorder.state !== 'inactive') {
        recorder.stop()
      }

      await stopped
      stream.getTracks().forEach((track) => track.stop())

      const blob = new Blob(chunks, {
        type: recorder.mimeType || mimeType || 'audio/webm',
      })

      if (!blob.size) {
        throw new Error('No audio captured.')
      }

      const audioBase64 = await blobToBase64(blob)
      return {
        audioBase64,
        format: mimeToFormat(blob.type || mimeType),
        byteLength: blob.size,
      }
    },
    cancel() {
      try {
        if (recorder.state !== 'inactive') {
          recorder.stop()
        }
      } catch {
        // already stopped
      }
      stream.getTracks().forEach((track) => track.stop())
    },
  }
}

function mimeToFormat(mimeType) {
  const value = String(mimeType || '').toLowerCase()
  if (value.includes('mp4') || value.includes('m4a') || value.includes('aac')) {
    return 'm4a'
  }
  if (value.includes('ogg')) return 'ogg'
  if (value.includes('mp3') || value.includes('mpeg')) return 'mp3'
  if (value.includes('wav')) return 'wav'
  return 'webm'
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('Could not read recorded audio.'))
    reader.onloadend = () => {
      const result = String(reader.result || '')
      const base64 = result.includes(',') ? result.split(',')[1] : result
      resolve(base64)
    }
    reader.readAsDataURL(blob)
  })
}
