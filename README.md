<p align="center">
  <img src="assets/icon/bezel.png" alt="Bezel" width="140">
</p>

<h1 align="center">Bezel</h1>

<p align="center">
  <img alt="GNOME Shell" src="https://img.shields.io/badge/GNOME%20Shell-48%E2%80%9351-4c4f69?style=flat-square">
  <img alt="Extension" src="https://img.shields.io/badge/extension-bezel%40deluca21-7287fd?style=flat-square">
</p>

<p align="center">
  A Caelestia-inspired shell for GNOME: one rounded frame, your own bars and docks, and drawers that join the desktop.
</p>

---

Bezel draws panels, docks, and popouts over GNOME Shell. Workspaces, apps, audio, session actions, and window space stay GNOME’s. The look is inspired by [Caelestia](https://github.com/caelestia-dots/shell).

---

## ✨ Features

- **Desktop frame** with a rounded opening, drawer joins, and a shadow that follows the palette.
- **Layouts** for a left rail, a bottom panel, a dock, or a top bar plus dock. Save your own and undo a preset.
- **Bars and docks** on any edge, floating or reserved, with pins, running apps, and modules you can reorder.
- **Launcher** on Super+Space. Search apps and Settings, run a calculation, convert a unit, or search the web with `!g`, `!yt`, `!r`, and the other bangs.
- **Quick controls** for volume, network, and Bluetooth, using GNOME’s own device lists.
- **Dashboard** for the calendar, media, performance, and workspaces.
- **Extension icons** hosted on a Bezel bar, with size, spacing, and order.
- **Palettes** including Catppuccin, Rosé Pine, Nord, and Bezel’s own colours, plus a custom palette.

---

## 📸 Screenshots

| Bezel | Panel | Top bar + dock |
| --- | --- | --- |
| <img src="assets/screenshots/bezel.png" alt="Bezel mode" width="280"> | <img src="assets/screenshots/panel.png" alt="Panel mode" width="280"> | <img src="assets/screenshots/top-dock.png" alt="Top bar and dock" width="280"> |

| Quick controls | Notification |
| --- | --- |
| <img src="assets/screenshots/quick-controls.png" alt="Quick controls" width="280"> | <img src="assets/screenshots/notification.png" alt="Notification" width="280"> |

---

## 📥 Installation

1. Copy or symlink `bezel@deluca21` into `~/.local/share/gnome-shell/extensions/`.
2. Compile the schema:

```sh
glib-compile-schemas --strict bezel@deluca21/schemas
```

3. Log out and back in.
4. Enable **Bezel** in Extensions.
5. Open preferences with Extensions, or:

```sh
gnome-extensions prefs bezel@deluca21
```

JavaScript changes need another logout on Wayland.

---

## 🔧 Preferences

Open **Layouts** to start from a built-in arrangement or load one you saved. Pins, the logo, and app behaviour carry over when you apply a built-in layout. Saved layouts keep the whole setup, including the palette.

On **Bar**, pick the bar, then set its edge, modules, floating inset, length, and whether windows reserve that space. App pins belong to that bar. Removing one does not change GNOME favourites.

**Launcher** sets Super, the launcher shortcut, and the overview shortcut. Super opens the overview unless you hand it to the launcher. **Frame & motion** sets the frame, hover, and where power, the dashboard, and notification history open.

---

## 🛠 Issues & Support

- Found a bug? Open a GitHub issue.
- Pull requests are welcome.

---

## Disclaimer

Bezel is not Caelestia, and it is not part of the GNOME project. It is a shell extension that uses GNOME’s own services. Some Caelestia pieces, including its full launcher providers, wallpaper browser, and stacked toasts, are not in this extension.
