# Voice clips (`public/audio/`)

FarmSignal speaks to the farmer with **pre-recorded clips**, not text-to-speech (PRD F9). `src/voice/play(key)`
looks up `manifest.json`; when a clip is marked `"ready"` it plays `/audio/<locale>/<key>.mp3`, otherwise it
falls back to the browser's `speechSynthesis` and the UI shows a **"Computer voice (TTS)"** label. The fallback
sentences are the `alerts:voice.*` strings in `src/i18n/locales/<locale>/alerts.json` — record the same text.

## Files

7 keys × 3 locales = **21 clips**:

| Key | `en/` | `hi/` | `ta/` |
|---|---|---|---|
| `welcome` | `en/welcome.mp3` | `hi/welcome.mp3` | `ta/welcome.mp3` |
| `batch_logged` | `en/batch_logged.mp3` | `hi/batch_logged.mp3` | `ta/batch_logged.mp3` |
| `alert_75` | `en/alert_75.mp3` | `hi/alert_75.mp3` | `ta/alert_75.mp3` |
| `alert_50` | `en/alert_50.mp3` | `hi/alert_50.mp3` | `ta/alert_50.mp3` |
| `alert_25` | `en/alert_25.mp3` | `hi/alert_25.mp3` | `ta/alert_25.mp3` |
| `sell_now` | `en/sell_now.mp3` | `hi/sell_now.mp3` | `ta/sell_now.mp3` |
| `recommendation_ready` | `en/recommendation_ready.mp3` | `hi/recommendation_ready.mp3` | `ta/recommendation_ready.mp3` |

## Format

- MP3, **mono**, **32 kbps** CBR, 22.05 kHz or 24 kHz sample rate (≈ 4 KB per second; every clip is under 40 KB
  so the whole set stays inside the service-worker precache budget).
- Peak-normalise to −1 dBFS; trim silence to ≤ 150 ms at the start and ≤ 300 ms at the end.
- A native speaker, calm and slightly slow (≈ 130 words/min), recorded in a quiet room 15–20 cm from the mic.
- ffmpeg from a WAV master:
  `ffmpeg -i welcome_ta.wav -ac 1 -ar 22050 -b:a 32k -codec:a libmp3lame ta/welcome.mp3`

## Enabling a clip

1. Drop the file at `public/audio/<locale>/<key>.mp3`.
2. In `manifest.json` set that entry's `"status"` to `"ready"`.
3. Rebuild (`npm run build`) — `**/*.mp3` is in the Workbox precache glob, so clips work offline.

`src/voice/voice.test.ts` checks the manifest lists exactly the 21 `(locale, key)` pairs.

## Script

Say the sentence exactly as written (it is the same text the TTS fallback speaks).

### English (`en`)

| Key | Sentence |
|---|---|
| `welcome` | Welcome to FarmSignal. Sell before it spoils. |
| `batch_logged` | Batch logged. Add a temperature reading to tighten the estimate. |
| `alert_75` | Attention: this batch has three quarters of its shelf life left. |
| `alert_50` | Attention: this batch has half of its shelf life left. Plan the sale. |
| `alert_25` | Warning: only a quarter of the shelf life is left. Sell today. |
| `sell_now` | Sell now. This batch will not last much longer. |
| `recommendation_ready` | Your mandi recommendation is ready. |

### Hindi (`hi`)

| Key | Sentence |
|---|---|
| `welcome` | फ़ार्मसिग्नल में आपका स्वागत है। खराब होने से पहले बेचें। |
| `batch_logged` | बैच दर्ज हो गया। अनुमान बेहतर करने के लिए तापमान की रीडिंग जोड़ें। |
| `alert_75` | ध्यान दें: इस बैच की तीन-चौथाई शेल्फ़ लाइफ़ बाकी है। |
| `alert_50` | ध्यान दें: इस बैच की आधी शेल्फ़ लाइफ़ बाकी है। बिक्री की योजना बनाएँ। |
| `alert_25` | चेतावनी: सिर्फ़ एक-चौथाई शेल्फ़ लाइफ़ बाकी है। आज ही बेचें। |
| `sell_now` | अभी बेचें। यह बैच ज़्यादा देर नहीं टिकेगा। |
| `recommendation_ready` | आपकी मंडी सिफ़ारिश तैयार है। |

### Tamil (`ta`)

| Key | Sentence |
|---|---|
| `welcome` | ஃபார்ம்சிக்னலுக்கு வரவேற்கிறோம். கெடுவதற்கு முன் விற்கவும். |
| `batch_logged` | தொகுதி பதிவு செய்யப்பட்டது. மதிப்பீட்டைத் துல்லியமாக்க வெப்பநிலை அளவீட்டைச் சேர்க்கவும். |
| `alert_75` | கவனம்: இந்தத் தொகுதியின் சேமிப்புக் காலத்தில் முக்கால் பங்கு மீதம் உள்ளது. |
| `alert_50` | கவனம்: இந்தத் தொகுதியின் சேமிப்புக் காலத்தில் பாதி மீதம் உள்ளது. விற்பனையைத் திட்டமிடுங்கள். |
| `alert_25` | எச்சரிக்கை: சேமிப்புக் காலத்தில் கால் பங்கு மட்டுமே மீதம். இன்றே விற்கவும். |
| `sell_now` | இப்போதே விற்கவும். இந்தத் தொகுதி இனி நீண்ட நேரம் தாங்காது. |
| `recommendation_ready` | உங்கள் மண்டி பரிந்துரை தயார். |

## Mute

Settings → Voice → "Mute voice prompts" stores `localStorage['fs.voice'] = "muted"`; `play()` then returns immediately.
