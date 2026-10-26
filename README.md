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
- **The Apple Pencil** writes anywhere on the page while a finger still scrolls and types, and a
  palm on the glass is ignored. Pen, highlighter, a stroke eraser, three inks and undo. Every
  stroke carries its recording time, strokes written together become one handwritten note, and
  each note shows in the transcript at its time (tap to hear that moment). Enhance sends each note
  to Claude as a picture labelled with its time, so Claude reads the handwriting and marks its
  words as yours. Without a Pencil, tapping a tool lets a finger draw. Settings can hand the Pencil
  to Apple's Scribble instead, which turns handwriting into typed text.
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
- **Delete**: long press a meeting in the list (or right-click) and tap Delete, or use the trash
  icon. It leaves the list at once and is gone for good after five seconds, with Undo until then.
- **Settings** shows each key's length and start, so a key cut short when pasted shows, and Check
  GitHub says whether the token works and can reach the repo.
- **Sync**: each meeting as JSON to `os-vault/notes/inbox/` on the `notes-inbox` branch of
  `agentic-os` (made from main on the first sync). There, `tools/notes/notes.py meetings` writes
  the note files the OS reads, with the Pencil page beside each as a picture (`<name>.ink.png`).
  Audio is never synced.

## Files

| File | What it is |
| --- | --- |
| `index.html` | The page and its styles (light and dark) |
| `app.js` | Notes, recording, transcription queue, playback, Claude, sync |
| `ink.js` | The Pencil: input, drawing, the eraser, handwritten notes, pictures for Claude |
| `whisper-worker.js` | Whisper in its own thread (transformers.js 3.8.1 from jsDelivr) |
| `pcm-worklet.js` | The microphone at 16 kHz, one second per message |
| `sw.js`, `manifest.webmanifest`, icons | Home-screen install and offline start |
| `docs/TEARDOWN.md` | Granola, Fireflies and Goodnotes taken apart, and the phases |
| `test/` | The end-to-end probe, the Pencil probe and the seam unit test |

## Test

```bash
OUT=/tmp/notes-test bash test/make_audio.sh
python3 -m http.server 8765 --bind 127.0.0.1 &
OUT=/tmp/notes-test node test/probe.js
OUT=/tmp/notes-test node test/ink-probe.js
node test/list-probe.js
node test/trim.mjs
```

The probe drives headless Chromium with a fake microphone playing a natural-voice meeting, the
real Whisper model, and Claude and GitHub mocked: 26 of 26 on 2026-10-26. Test with a natural
voice: Whisper skips robot speech (espeak). The Pencil probe sends real pen events (Chrome's
DevTools protocol reports them as `pointerType: "pen"`, as Safari does for the Pencil): 23 of 23.
What only an iPad can prove: palm rejection, that a Pencil touch on the notepad does not start
Scribble or the keyboard, and how pressure feels.

## Next

1. **The real app** (Matt asked for a widget, 2026-10-26): the same code wrapped with Capacitor,
   a WidgetKit widget (start a meeting, today's meetings, latest action items), recording that
   keeps going in the background, Apple's own speech recognition, TestFlight.
2. **The Pencil, next**: tap ink on the page to replay its moment, lasso to move ink, search
   inside handwriting once Claude has read it, and the Pencil's double tap (needs the real app).
3. **Teams meetings**: Teams' own speaker-labelled transcripts through Microsoft Graph, and the
   Outlook calendar naming the meeting.
