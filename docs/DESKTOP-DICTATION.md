# Desktop dictation

Speech-to-text in the desktop app (Electron on Windows). Added 2026-11-22. The phone is unchanged: it still uses Android's own recognizer.

## How to use it

In any session, with the composer on screen:

- **Ctrl+D** starts listening, wherever the cursor is. **Ctrl+D again** stops, and the text stays in the composer for you to read and fix. Enter sends it, as always.
- **Hold Ctrl+D** while you talk and let go: the same thing as push-to-talk. A hold is 0.6 seconds or longer.
- **Enter while it is listening** stops and sends in one step.
- **Esc** cancels. Nothing is added, and the composer goes back to what it held before.
- The **mic button** beside the composer is the same button as on the phone: hold it to talk, or click once to latch and click again to stop.
- "Send on release" in Settings → Voice applies here too: when it is on, stopping sends the text without a review.

The text appears live while you talk, about a second behind your voice. A dictation that is left on ends itself after 15 seconds of silence and keeps what was said. One dictation can be up to 10 minutes long.

The first dictation ever downloads the speech model (281 MB, once). You can talk during the download; nothing is lost. After that it works with no internet connection.

On a Mac, Cmd+D does the same as Ctrl+D.

## Why toggle, and why Ctrl+D is safe

Dictation in Claude's own apps is a toggle: click the microphone, speak, the words appear in the composer, click again to stop and review, or press Enter to stop and send (Anthropic's dictation page for Claude in Office, which says it is the same dictation as in the Claude apps: claude.com/docs/office-agents/dictation). HomeBase does the same, and adds the hold because the phone's mic button already works that way. No published page was found that documents a Ctrl+D shortcut in the Claude desktop app, so the key itself follows the owner's description, and the behaviour follows that page.

Ctrl+D had no job in this app: there are no other keyboard shortcuts except Enter in the composer, the Electron window has no menu (so no browser accelerators), and Chromium gives Ctrl+D no meaning inside a text field on Windows. The shortcut is not global: it only works while the HomeBase window has the keyboard, so it does not take Ctrl+D away from other programs. It does nothing while a sheet or dialog is open on top of the session.

## The engine: Whisper, on this PC

The desktop shell runs OpenAI's Whisper model locally through `@huggingface/transformers` (onnxruntime). No audio leaves the PC and no API key is involved.

| | |
|---|---|
| Default model | Whisper `base.en` ("Fast" in Settings → Voice) |
| Optional model | Whisper `small.en` ("Accurate"): fewer wrong words, slower live text |
| Runs on | the graphics card through DirectML when there is one, otherwise the processor |
| Model files | `%LOCALAPPDATA%\HomeBase\models` (not in the source tree, not in `data/`) |
| Download size | base.en: 281 MB on the graphics card, 77 MB on the processor. small.en: 334 MB / 249 MB |
| npm packages | `@huggingface/transformers` 4.3.2 in `apps/desktop` (37 packages, about 480 MB in `node_modules`, mostly onnxruntime binaries for every platform) |

### What was tried

Measured on this PC (i7-14700F, RTX 5060 Ti) with three clips made by the Windows speech synthesizer (4.8, 13.1 and 29.7 seconds), a real recording (the JFK clip), 30 seconds of a TED talk, and the synthesized clips with noise added.

| Option | Time for the 4.8 / 13.1 / 29.7 s clips | Quality | Verdict |
|---|---|---|---|
| Web Speech API (`webkitSpeechRecognition`) | none | In Electron 45 the object exists and `start()` ends with `error: network`: it needs Google's speech service and key. | Does not work |
| Windows built-in recognizer (System.Speech, through PowerShell) | 0.2 / 0.6 / 0.9 s | Poor even on Windows' own synthetic voice: "Bouquet here is what I want", "desktop mapping", "stage and apply for", "Townsend anything". No punctuation or capitals. | Rejected |
| Whisper `tiny.en`, processor | 1.2 / 1.8 / 2.6 s | Good on clean speech, first to slip with noise (7.7% wrong words at 3 dB) | Rejected |
| **Whisper `base.en`, graphics card** | **0.4 / 0.8 / 1.4 s** | No wrong words on the clean clips and the JFK clip; 5.1% at 3 dB noise; one wrong word in the TED clip ("taste civil") | **Default** |
| Whisper `base.en`, processor only | 2.0 / 2.6 / 5.2 s | Same text | Fallback, chosen automatically |
| Whisper `small.en`, encoder on the graphics card | 1.0 / 1.7 / 3.2 s | Best: 2.6% at 3 dB noise, TED clip right | Offered as "Accurate" |
| Distil-Whisper `distil-small.en` | 1.9 / 2.9 / 3.7 s | Dropped half the JFK sentence, repeated phrases | Rejected |
| Moonshine `base` | 0.4 / 1.3 / 2.5 s | Words fine, punctuation sometimes missing entirely | Rejected |
| Sending audio to the hub | not built | the server would need the model and the CPU for it; adds a network hop; nothing gained while the PC has a good CPU and GPU | Kept as a later option for the browser |

Whisper `large-v3-turbo` would be better again but is 800 MB or more, and `small.en` fully on the graphics card needs a 970 MB download; both are over the 500 MB limit set for this work and were not downloaded.

### Measured in the app

Run in Electron on this PC with a WAV file as the microphone (Chromium's fake audio device), so the whole path is real except the microphone itself: `getUserMedia`, the audio worklet, IPC, the model process, the composer.

| | |
|---|---|
| Accuracy, 30-second clip, six runs | No wrong words in any run (two segment joins per run) |
| First live text after you start talking | 0.8 to 1.1 s once the model is loaded |
| First dictation after the app starts | Model loads in 2.5 to 3 s; what you say meanwhile is kept and appears when it is ready |
| First dictation ever | 281 MB downloaded in about 6 s here, with a percentage shown; the text for everything said appeared 9 s after starting |
| Final text after stopping, when you paused first | 0 to 0.2 s (the last live pass already has it) |
| Final text after stopping mid-sentence | 0.3 to 1.2 s in the first set of runs, 1.2 to 2.1 s in later ones |
| "Accurate" model | Live text 3 to 5 s behind, final text about 1.5 s after stopping |

The spread in the mid-sentence number is real and not explained: later in the session each model pass took about twice as long inside the app (a 5-second clip in 0.9 to 1.1 s instead of 0.55 s) while the same model run outside the app stayed fast, and processor-only passes were not affected, so it is something on the graphics card side. A 336-pass soak outside the app showed no slowdown or memory growth.

### Tradeoffs of this choice

- **Live text is not true streaming.** Whisper reads a whole clip at once. The shell re-reads the clip so far about once a second, so the last few words can change while you talk. When a clip passes 12 seconds, everything up to the last pause is settled and a new clip starts, which keeps each pass short.
- **Stopping mid-sentence costs a pass or two.** A pass that is running cannot be interrupted, and one more pass reads the last words. The phone's recognizer answers faster here.
- **A model in memory.** The model process starts on the first dictation and is closed after 10 minutes without one.
- **Names.** The phone hands the recognizer agent, session and client names as hints. Whisper is not given them yet, so unusual names ("HomeBase") can come out as ordinary words ("home base").
- **English only.** Both models are the `.en` versions.
- **Dependency weight.** 480 MB in `node_modules` for the desktop app only. The phone build and the web bundle do not include any of it.

## How it is built

```
 window (apps/client)                         desktop shell (apps/desktop)
 Composer / MicButton / Ctrl+D
   useDictation                               main.mjs: microphone permission (audio only, own pages only)
     DesktopRecognizer ── hb:stt-* IPC ──►    stt.mjs + sttCore.mjs: broker, one dictation at a time
       capture.ts: getUserMedia, 16 kHz mono     └─ utilityProcess: sttWorker.mjs runs Whisper
     ◄── live text, final text, errors ──────
```

- `apps/client/src/voice/VoiceInput.ts` picks the recognizer: `DesktopRecognizer` when the shell's bridge (`window.homebaseDesktopStt`) is there, the phone's recognizer otherwise. Everything that dictates (the composer, quick capture, Notes "Add to today") uses the same `useDictation` hook, so they all work on the desktop.
- `apps/client/src/voice/dictationShortcut.ts` is the Ctrl+D state machine and `dictationDraft.ts` is how text lands in the composer; both are pure and tested.
- `apps/desktop/sttCore.mjs` has everything that needs neither Electron nor the model: the model profiles, splitting long dictations at pauses, skipping silence (Whisper invents words for silence), the IPC guards and the permission rule. Tested in `apps/desktop/test/stt.test.ts`.
- Microphone permission: the shell's permission handlers allow `media` only when the request is audio-only and comes from the app's own origin. Camera, screen capture and everything else stay denied. If Windows blocks the microphone or there is none, the composer says so in one line.

## Checking it without a microphone

```
node scripts/stt-check.mjs clip.wav                      # one pass, prints the text and the time
node scripts/stt-check.mjs clip.wav --realtime            # feeds it at speaking speed, prints the live text
node scripts/stt-check.mjs clip.wav --profile accurate --device cpu
```

The whole path can be run in Electron with a WAV file as the microphone: start Electron with `--use-fake-device-for-media-stream --use-file-for-fake-audio-capture=C:\path\clip.wav`. `HB_STT_DEBUG=1` prints one line per model pass in the shell's log.

Environment variables for the shell: `HB_STT_PROFILE` (`fast` or `accurate`), `HB_STT_DEVICE` (`auto`, `gpu`, `cpu`), `HB_STT_MODEL_DIR`.
