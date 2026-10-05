# Launcher and settings regressions

Run from the repository root with GJS and its Gio/GLib introspection libraries installed:

```sh
gjs -m tests/launcher-settings-regressions.js
```

The suite checks visible launcher row reuse, app catalog invalidation, search scoring
(including 3,969 comparisons with the former edit-distance algorithm), bounded file
search ranking, settings scroll callback cleanup, group self-drop, and live-folder
refresh cancellation and navigation cleanup.

File search uses real temporary files and asynchronous Gio enumeration. The test
removes its temporary fixtures when finished. Shell actors and settings callbacks
are exercised with controlled test doubles; no running GNOME Shell or changes to
user preferences are required.

This suite does not measure live Shell memory use, frame rate, keyboard focus, or
rendered appearance. Before release, also check launcher keyboard navigation across
result windows, rapid file-query changes, navigation while a folder is loading, and
closing preferences during a scroll restoration in a GNOME Shell session.
