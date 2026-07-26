# Generated audio

The WAV files in this directory are generated locally by
`godot/tools/generate_audio.mjs`. They reproduce the tone shapes and event
vocabulary of the web client's generated Web Audio effects without requiring
runtime synthesis on mobile.

Run `node godot/tools/generate_audio.mjs` after intentional changes to the
generator. The output is original project material and has no third-party
audio licensing dependency.
