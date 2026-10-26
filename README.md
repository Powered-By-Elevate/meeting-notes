# Meeting Notes

Matt's own iPad meeting notes app, built the Granola way: type the few things worth typing while it
records, the iPad transcribes as you go, and Claude turns your notes and the transcript into the
meeting record. Each meeting syncs into Agentic OS, so every Claude session can read it.

**Live at https://powered-by-elevate.github.io/meeting-notes/** (served free by GitHub Pages
from this repo's `main`). The code holds no data and no keys, which is why it can be public.
Everything personal stays on the iPad.

## Install on the iPad

1. Open the address above in Safari.
2. Share, Add to Home Screen. Open it from the new icon (full screen, its own storage).
3. Settings (the gear): paste an Anthropic API key (for the write-up and Ask, billed per use) and a
   fine-grained GitHub token with Contents read and write on `Powered-By-Elevate/agentic-os` only
   (for sync). Add the people you meet with to "Names and words to expect". Save.
4. New meeting (Command K), Record (Command J), allow the microphone. The first time, the
   transcription model downloads (about 206 MB, once).
5. Stop, wait for "Transcript is up to date", then Enhance (Command E).

Keep the app open and the iPad awake while it records: iPadOS pauses the microphone for a
home-screen web app in the background. Deleting the home-screen icon deletes its data, and sync is
the backup. Say a meeting is being recorded.

## What it does

- **Notepad** with each line stamped on the recording's clock.
- **Recording in the app**, saved every 22 seconds, so a crash loses at most that.
- **Transcription on the iPad**: Whisper (`whisper-base.en`, or small in Settings) in a background
  thread, each piece heard with the 8 seconds before it so a sentence cut at a seam is caught. The
  audio never leaves the iPad. Safari's live captions are an optional extra.
- **Transcript tab**: your lines in bold among the transcript on one clock. Tap a line to hear
  that moment.
- **Enhance**: Claude writes summary, decisions, action items with owners, filled-out notes and
  quotes, your own words dark and Claude's grey. Seven meeting types steer it, and a list of
  expected names fixes transcript mishearings.
- **Ask** about one meeting, or start with `all:` to ask across all of them.
- **Search** across titles, notes, transcripts and records.
- **Sync**: each meeting as JSON to `os-vault/notes/inbox/` on the `notes-inbox` branch of
  `agentic-os` (made from main on the first sync). There, `tools/notes/notes.py meetings` writes
  the note files the OS reads. Audio is never synced.

## Files

| File | What it is |
| --- | --- |
| `index.html` | The page and its styles (light and dark) |
| `app.js` | Notes, recording, transcription queue, playback, Claude, sync |
| `whisper-worker.js` | Whisper in its own thread (transformers.js 3.8.1 from jsDelivr) |
| `pcm-worklet.js` | The microphone at 16 kHz, one second per message |
| `sw.js`, `manifest.webmanifest`, icons | Home-screen install and offline start |
| `docs/TEARDOWN.md` | Granola, Fireflies and Goodnotes taken apart, and the phases |
| `test/` | The end-to-end probe and the seam unit test |

## Test

```bash
OUT=/tmp/notes-test bash test/make_audio.sh
python3 -m http.server 8765 --bind 127.0.0.1 &
OUT=/tmp/notes-test node test/probe.js
node test/trim.mjs
```

The probe drives headless Chromium with a fake microphone playing a natural-voice meeting, the
real Whisper model, and Claude and GitHub mocked: 23 of 23 on 2026-10-26. Test with a natural
voice: Whisper skips robot speech (espeak).

## Next

1. **The real app** (Matt asked for a widget, 2026-10-26): the same code wrapped with Capacitor,
   a WidgetKit widget (start a meeting, today's meetings, latest action items), recording that
   keeps going in the background, Apple's own speech recognition, TestFlight.
2. **The Apple Pencil**: a handwriting page, strokes stamped in time, Claude reading the page, tap
   ink to replay.
3. **Teams meetings**: Teams' own speaker-labelled transcripts through Microsoft Graph, and the
   Outlook calendar naming the meeting.
