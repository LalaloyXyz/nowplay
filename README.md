# Now Play

A GNOME Shell extension that shows a sleek popup media player widget when you hover over or click the clock in the top panel.

Compatible with **Spotify** and any other **MPRIS-compatible** media player (Rhythmbox, VLC, Firefox, etc.).

![GNOME Shell version](https://img.shields.io/badge/Shell-46%20|%2047%20|%2048%20|%2049%20|%2050-blue)

## Features

- **Hover or click the clock** to open the media popup
- **Album art** — displays cover art in a rounded frame with drop shadow
- **Track info** — song title and artist, ellipsized when too long
- **Playback status pill** — "Live" (green) or "Paused" (grey) indicator
- **Seek bar** — real-time progress bar that updates every second
- **Time display** — current position / total duration
- **Media controls** — Previous | Play/Pause | Next buttons
- **Smooth animations** — popup fades in/out with a subtle scale effect
- **Auto-close** — popup closes after inactivity; stays open while your cursor is on it
- **Dark frosted glass design** — macOS-style dark theme with rounded corners
- **Escape key** — dismiss the popup with the Escape key

## Requirements

- GNOME Shell 46, 47, 48, 49, or 50
- An MPRIS-compatible media player

## Installation

### From source

```bash
git clone https://github.com/LalaloyXyz/nowplay.git
cd nowplay
cp -r nowplay@LalaloyXyz ~/.local/share/gnome-shell/extensions/
```

Then restart the shell (Alt+F2, type `r`, press Enter) or log out and back in.

Enable via GNOME Extensions app or:

```bash
gnome-extensions enable nowplay@LalaloyXyz
```

## Usage

Once enabled, hover your mouse over the clock in the top panel (or click it) to open the Now Play popup. The popup shows:

- Album artwork (or a fallback audio icon)
- Track title (bold)
- Artist name
- Play/pause status pill
- Progress bar with elapsed / total time
- Playback controls (skip back, play/pause, skip forward)

Move your cursor away and the popup auto-closes after a short delay. Hover back over it to keep it open.

## Support

- [Ko-fi](https://ko-fi.com/pleumlookchill)
