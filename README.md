<p align="center">
  <img src="./assets/icon/bezel.png" alt="Bezel" width="140">
</p>

# Bezel

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

<p align="center">
  <img src="./assets/screenshots/bezel.gif?v=2" alt="Bezel in motion">
</p>

<p align="center">
  <img src="./assets/screenshots/bezel.png" alt="Bezel mode"><br>
  <sub>Bezel</sub>
</p>

<p align="center">
  <img src="./assets/screenshots/panel.png" alt="Panel mode"><br>
  <sub>Panel</sub>
</p>

<p align="center">
  <img src="./assets/screenshots/top-dock.png" alt="Top bar and dock"><br>
  <sub>Top bar and dock</sub>
</p>

<p align="center">
  <img src="./assets/screenshots/quick-controls.png" alt="Quick controls"><br>
  <sub>Quick controls</sub>
</p>

<p align="center">
  <img src="./assets/screenshots/notification.png" alt="Notification"><br>
  <sub>Notification</sub>
</p>

<p align="center">
  <img src="./assets/screenshots/dashboard.png" alt="Dashboard"><br>
  <sub>Dashboard</sub>
</p>

---

## 📥 Installation

Clone the repository, move the extension into GNOME’s extensions folder, compile the settings schema, then delete the clone:

```sh
git clone https://github.com/DeLuca21/Bezel.git
cd Bezel
mkdir -p ~/.local/share/gnome-shell/extensions
mv bezel@deluca21 ~/.local/share/gnome-shell/extensions/
glib-compile-schemas --strict ~/.local/share/gnome-shell/extensions/bezel@deluca21/schemas
cd ..
rm -rf Bezel
```

Log out and back in, then enable **Bezel** in Extensions.

Open preferences from Extensions, or:

```sh
gnome-extensions prefs bezel@deluca21
```

JavaScript changes need another logout on Wayland.

---

## 🔧 Preferences

Bezel settings open in a dedicated custom app, from the dashboard, launcher, Extensions app, or a bar’s right-click menu. Its palette, rounded cards and visual editor match Bezel. It runs as a real window with normal stacking, resizing and Super-dragging.

Preset cards and saved-layout chips sit above an interactive desktop preview and independently scrollable editor. Click a bar to select it, then use Contents, Size & space, or Apps & logo. Modules appear as chips inside sections and groups. Palettes show swatch cards; custom colours use GNOME’s picker. Switching layouts with unsaved changes offers Cancel, Discard, or Save and switch.

Right-click a bar for settings, edit mode, panel or dock, floating, autohide, and remove. Edit mode outlines the bars, puts **+** on empty screen edges and on each section, and lets you drag what is already there. Edit mode never opens settings automatically. Right-click a module while editing to remove it, create a group, or move it into an existing group. Groups can contain any modules and empty spaces; removing a group keeps its contents. Resize spaces from their edit menu or click their chip in settings for an exact pixel size. App pins stay on the app’s right-click menu.

---

## 🛠 Issues & Support

- Found a bug? Open a GitHub issue.
- Pull requests are welcome.

---

## Disclaimer

Bezel is not Caelestia, and it is not part of the GNOME project. It is a shell extension that uses GNOME’s own services. Some Caelestia pieces, including its full launcher providers, wallpaper browser, and stacked toasts, are not in this extension.
