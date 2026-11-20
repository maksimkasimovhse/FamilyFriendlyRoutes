# Apple emoji used by the interface

Local 64×64 PNGs from `emoji-datasource-apple@16.0.0` ([upstream](https://github.com/iamcal/emoji-data)). Exact source URLs and Unicode values are recorded in `manifest.json`. Package license is preserved in `LICENSE.package`; emoji artwork rights remain with Apple, as described by the upstream project's Image Sources and License sections.

The app loads these local assets rather than system emoji fonts, so Windows, Android and iOS display the same artwork. Food uses 🍽️ (U+1F37D U+FE0F), as requested. Map textures, stop markers, category filters and cards share the mapping in `frontend/js/place-display.js`.
