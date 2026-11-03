# Scene background

The live-scene area uses a looping clip, not this directory:

- `public/scene/pond-loop.mp4` — 21.9s, 2560×1440, 60fps, H.264, ~12 Mbps.
  First and last frames already match, so it loops without a visible cut.
- `public/scene/pond-poster.jpg` — first frame, shown before playback and
  whenever reduced motion is on.

Both live in `public/` so the original bitrate survives the Vite build. The hero
pauses the clip while the window is hidden and while "减弱动态效果" is enabled.

They are bundled only so the launcher can be designed and reviewed without a
running Fabric Bridge. The production scene is the live game frame; replace the
clip when the bridge is connected.

`dafeiyu.png` is the character reference supplied by the project owner. It is
transparent-cut from the original JPEG and used for the in-app character card
and the desktop icon. The icon plates the artwork on a white rounded background
(no blue fill) and is exported to `apps/desktop-shell/src-tauri/icons/` as
`.icns`, `.ico`, and per-size PNGs. Character artwork rights still need to be
cleared before public distribution; see the persona note in `README.md`.
