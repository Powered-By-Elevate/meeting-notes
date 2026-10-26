#!/usr/bin/env bash
# The probe's fake meeting: two topics read by Google's text-to-speech (a natural voice), into
# $OUT/meeting2.wav. espeak-ng's robot voice is a poor test: Whisper skips whole sentences of it.
set -euo pipefail
OUT=${OUT:-.}
python3 -m pip install -q gTTS
python3 - "$OUT" <<'PY'
import sys
from gtts import gTTS
out = sys.argv[1]
gTTS("Okay, thanks everyone for making time. Let's start with the Riverbend draw. The bank wants the updated construction budget by Friday, and they asked for the revised proforma with the new interest rate. Walt, can you send the lender the signed change orders? Vicki will pull the October rent roll for Essentia.").save(f"{out}/g1.mp3")
gTTS("Next item. The Timberley refinance. Morris Bank quoted six point two five percent on a five year term. We need the appraisal ordered this week. Matt will update the debt schedule and circulate it on Monday. Any questions? Great, let's wrap up there.").save(f"{out}/g2.mp3")
PY
ffmpeg -y -loglevel error -i "$OUT/g1.mp3" -i "$OUT/g2.mp3" -filter_complex "[0][1]concat=n=2:v=0:a=1,atempo=1.15,apad=pad_dur=3,aresample=48000" -ac 1 "$OUT/meeting2.wav"
echo "$OUT/meeting2.wav"
