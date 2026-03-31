# Jungle Jambu — Series Assets

This directory holds static series assets for the **Jungle Jambu** series.
These files are referenced by `scripts/assemble-jungle-jambu.mjs` during assembly.

## Assets

### `intro.mp4` *(to be generated)*
Series intro clip featuring a rifle-hole-zoom effect that reveals the Jungle Jambu title card.
Prepended to every episode before the main story content.
Text overlay (EP number + episode title in Tamil) is applied at assembly time via ffmpeg `drawtext`.

### `end_card.mp4` *(to be generated)*
Jungle Jambu branded end card — replaces the standard TTT end card for this series.
Appended after the main story content.

### `character-ref.png` *(to be generated)*
Jungle Jambu character reference image for consistent illustration across episodes.
Character: Chubby man in his 20s, khaki hunter uniform, cross belt, binoculars, rifle, hunter hat.
Used as a visual anchor for Stage 3 (character prep) and Stage 4 (illustration).

## Notes

- All three files are intentionally absent from the repo until generated.
- Assembly (`assemble-jungle-jambu.mjs`) skips intro/end-card gracefully if files are missing.
- Font for text overlay: Noto Sans Tamil (`NotoSansTamil-Regular.ttf`). Install via Homebrew or system fonts.
