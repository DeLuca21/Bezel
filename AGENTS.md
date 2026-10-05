# Local installation

The user wants changes in this project made available in their local Bezel installation after each task.

- After changing and verifying extension code, run `python3 scripts/install-local.py` before reporting completion. This local installation is already authorized; do not ask for confirmation again.
- The installer copies the current workspace extension, compiles its schemas, verifies the installed files, and backs up the previous installation under `.backups/`.
- Preserve the user's GNOME settings. Do not automatically log out or restart their desktop session.
- Distinguish installed files from code loaded by the running Shell. On Wayland, tell the user when a logout/login is needed to load updated extension JavaScript.
