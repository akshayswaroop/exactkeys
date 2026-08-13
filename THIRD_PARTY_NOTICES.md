# Third-party notices

ExactKeys does not commit downloaded media or third-party executable binaries.

## Spotify Basic Pitch

Audio-draft inference uses `@spotify/basic-pitch` and its model weights. Basic Pitch is Copyright 2022 Spotify AB and licensed under the Apache License, Version 2.0. The npm dependency includes that license; `npm run setup:basic-pitch` copies the model and its license together into the local runtime assets.

Upstream: <https://github.com/spotify/basic-pitch-ts>

## yt-dlp

The local YouTube resolver can download a pinned official yt-dlp macOS executable directly from the upstream release page after verifying its SHA-256 checksum. The executable is excluded from this repository. yt-dlp's source is released under the Unlicense, while upstream documents additional licenses that apply to bundled release executables.

Upstream licensing: <https://github.com/yt-dlp/yt-dlp#licensing>

## JavaScript packages

Other runtime and development dependencies are declared in `package.json` and locked by `package-lock.json`; their license files are installed by npm with the packages.
