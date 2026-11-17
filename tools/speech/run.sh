#!/usr/bin/env bash
# Machine listening test: TTS speech -> Halka mic -> full voice pipeline + network -> Whisper.
# Needs: Windows (SAPI TTS), Python with `pip install faster-whisper numpy`.
set -e
cd "$(dirname "$0")"
w=$(mktemp -d)
powershell -NoProfile -Command "Add-Type -AssemblyName System.Speech; \$s=New-Object System.Speech.Synthesis.SpeechSynthesizer; \$f=New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(48000,[System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,[System.Speech.AudioFormat.AudioChannel]::Mono); \$s.SetOutputToWaveFile('$(cygpath -w "$w/in.wav")', \$f); \$s.Speak('Hello friends. The quick brown fox jumps over the lazy dog. Can you hear me clearly through the ring?')"
(cd ../.. && HALKA_TEST_WAV="$(cygpath -w "$w/in.wav")" HALKA_TEST_OUT="$(cygpath -w "$w/out.wav")" cargo test -q --test e2e speech -- --ignored)
python transcribe.py "$w/in.wav" "$w/out.wav"
