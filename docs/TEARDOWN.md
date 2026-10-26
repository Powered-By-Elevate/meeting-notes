# Granola, Fireflies and Goodnotes, taken apart

Matt, 2026-10-26: *"can we go ahead and reverse engineer granola and goodnotes and fireflies. let's
plan for the apple pencil but for right now i will just use my bluetooth keyboard and the recorder
for transcription. that way we can test"*, and the recorder *"needs to live within the app"*.

**Method.** All three are closed apps. This teardown is built from what each one does in use and
what each company publishes (docs, security pages, API references). Nothing was decrypted or
decompiled: App Store binaries are encrypted, and breaking that is circumvention. The goal is our
own app that does what we want from each, which needs none of their code.

## Granola: the notepad that listens

| How it works | What we take |
| --- | --- |
| No bot joins the call. The app listens to the device's own audio, so nobody sees a recorder join. | Recording lives inside the notes app. One button, no second device to sync. |
| You type sparse notes while it listens. After the meeting it writes full notes from your notes plus the transcript. | The same flow: type during, enhance after. |
| Your typed words stay visually distinct from what the AI added (yours dark, the AI's grey), so you can trust what you wrote. | The enhanced note marks your own words, and the screen draws them dark and the rest grey. |
| Notes take a shape from the meeting type (interview, sales call, pitch). Granola calls these templates and recipes. | Templates for Matt's meetings: general, one on one, client or partner, bank or lender, site walk, internal team, interview. |
| Transcription runs in the cloud in real time (Deepgram and AssemblyAI per Granola's own security page). Audio is cached only to transcribe, then deleted. | Transcription runs **on the iPad** with Whisper, so the audio never leaves it, and the audio is deleted once the transcript exists (a setting). |
| Chat answers questions across your meeting history. API and MCP access let other tools read the notes. | Ask, about one meeting or all of them. Every meeting syncs into the repo, so every Claude session can read it. |
| Calendar briefs prepare you before a meeting. | Later: the Outlook calendar through the Microsoft 365 connector names the meeting and the people for you. |

## Fireflies: the bot that joins the call

| How it works | What we take |
| --- | --- |
| A bot joins calendar meetings (Zoom, Teams, Meet) and records them. Uploads of audio files also work, through its GraphQL `uploadAudio` call. | No bot. In-person meetings record on the iPad. Teams meetings already have Teams' own transcription, which Microsoft Graph serves (`onlineMeetings/{id}/transcripts`) once Cortavo grants the read, so a bot would duplicate it. Phase 3. |
| Speaker-labelled transcript with timestamps. Accuracy drops with overlapping voices. | Timestamps now. Speaker labels come with the Teams transcripts (Teams labels speakers). Whisper on the iPad does not tell voices apart, and the enhance step says so rather than guessing who spoke. |
| A fixed summary shape: overview, action items, outline, keywords. | The house note shape in `tools/notes/README.md`: summary, decisions, action items with owners, notes, transcript highlights. |
| Ask Fred answers questions about one meeting or many. | Ask, as above. |
| A searchable archive, plus integrations that push tasks into other tools. | Search in the app. Action items reach Claude through the repo, and from there anywhere the OS already writes. |

## Goodnotes: ink first (the Apple Pencil phase)

| How it works | What we take |
| --- | --- |
| Its own ink engine on the iPad, with pressure and palm rejection. | A drawing canvas on Pointer Events. Safari reports the Apple Pencil as `pointerType: "pen"` with pressure and tilt, so finger touches can be ignored while writing. |
| Handwriting recognition on Apple's Neural Engine makes every page searchable and convertible to text. | Claude reads the page image directly (it already does in the PDF pipeline), so the typed text comes out formatted, not just recognised. |
| Audio recording synced to the ink: tap a word and playback jumps to what was being said as you wrote it. Notability is built around the same feature. | Every stroke carries its time from the start of the recording, exactly like typed lines do in v1, so tapping ink can play the audio from that moment. |
| Notebooks, templates, PDF markup, and an AI meeting assistant on the Pro tier (Mac first). | Meetings are the notebook. PDF markup stays with Goodnotes if he ever needs it. |

## The phases

1. **v1, now (keyboard and in-app recording).** `tools/notes/app/`. Type with the Bluetooth
   keyboard, record in the app, live captions where Safari allows them, a Whisper transcript on the
   iPad after the meeting, enhance and ask with Claude, sync into the repo.
2. **v2, the Pencil.** A handwriting page beside or instead of the typed notepad, strokes stamped
   in time, Claude reading the page, tap ink to replay audio.
3. **v3, the calls.** Teams transcripts from Graph (speaker labelled, no bot), and the Outlook
   calendar naming the meeting and its people.

## Sources

- Granola, security and how it works: https://jobs.granola.so/security and
  https://docs.granola.ai/help-center/consent-security-privacy/security-privacy-data-faqs
- Granola announcement: https://www.granola.ai/blog/announcement
- Fireflies upload API: https://docs.fireflies.ai/graphql-api/mutation/upload-audio
- Goodnotes 6: https://goodnotes.com/blog/introducing-goodnotes-6 and
  https://techcrunch.com/2023/08/09/goodnotes-biggest-update-in-four-years-brings-ai-powered-handwriting-features-and-a-digital-marketplace
- Safari speech recognition in home screen apps: https://bugs.webkit.org/show_bug.cgi?id=225298
