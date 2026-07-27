# Bundled typefaces

The native client bundles the same two families used by the web client:

- **Fredoka** for the logo, scores, buttons, and game feedback;
- **Nunito** for body copy, labels, and compact HUD information.

The variable originals are retained alongside deterministic static weight
instances generated with fontTools. Godot loads those static instances so font
weight rendering stays identical across desktop, Android, and iOS.

Both files come from the official
[Google Fonts repository](https://github.com/google/fonts), are licensed under
the SIL Open Font License 1.1, and are stored with their respective `OFL.txt`.
The fonts are bundled locally so native builds never depend on a font CDN.
