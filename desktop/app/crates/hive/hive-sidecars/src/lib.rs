//! Clients of the model sidecars (listen, speech, voiceprint) and the captions overlay.
//!
//! The models stay in Python; everything around them is here.
//!
//! - [`voice`]: python/sidecar_voice.py, one process with listen.py's `Ears` (microphone, mic.py's
//!   echo canceller, Silero VAD, Parakeet), voiceprint.py and speech.py's `Voice` (Kokoro). Rust gets
//!   [`Ears`], [`Voice`] and [`Voiceprint`] handles named after the Python.
//! - [`captions`]: python/captions.py, the client of build/agent-vhid-captions (tools/captions.swift).
//! - [`audio`]: python/audio.py, what CoreAudio says about the Mac's sound devices.

pub mod audio;
pub mod captions;
mod process;
pub mod voice;

pub use captions::Captions;
pub use voice::{Ears, Microphone, Voice, VoiceOptions, VoiceSidecar, Voiceprint};
