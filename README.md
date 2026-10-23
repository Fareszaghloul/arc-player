# Arc

Arc is a desktop media client for Jellyfin servers, forked from
[Jellyfin Desktop](https://github.com/jellyfin/jellyfin-media-player). It keeps the
upstream architecture: a Qt 6 shell hosting Qt WebEngine for the server-served web
client, with [libmpv](https://github.com/mpv-player/mpv) for playback (audio
passthrough, hardware decoding, and direct play of formats the browser cannot handle).

Arc is not affiliated with or endorsed by the Jellyfin project.

## Building

See [dev/](dev/) for platform-specific build instructions. On Windows the project
must live at a path without spaces (Qt 6.10's `qt_add_qml_module` cannot handle them).

## File locations

Data is stored per profile in a `profiles/<profile-id>/` subdirectory. The main
configuration file is `arc-player.conf`. Add `mpv.conf` alongside it to configure mpv
directly.

**Windows:** `%LOCALAPPDATA%\Arc\profiles\<profile-id>\` (config, cache, `logs\`)

**Linux:** `~/.local/share/arc-player/profiles/<profile-id>/` (config, logs),
`~/.cache/arc-player/profiles/<profile-id>/` (cache)

**macOS:** `~/Library/Application Support/Arc/profiles/<profile-id>/` (config),
`~/Library/Caches/Arc/profiles/<profile-id>/` (cache), `~/Library/Logs/Arc/<profile-id>/`

## Debugging the web layer

Run with `--remote-debugging-port=9222`, then open `chrome://inspect/#devices` in a
Chromium browser and add `localhost:9222` as a network target.

## License

GPL-2.0, as upstream. See [LICENSE](LICENSE).
