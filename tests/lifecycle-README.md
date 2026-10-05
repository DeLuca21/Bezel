# Service and widget lifecycle regressions

Run from the repository root with GJS and GLib installed:

```sh
G_DEBUG=fatal-criticals gjs -m tests/lifecycle-regressions.js
```

The suite executes extension code with controlled actors and asynchronous replies.
It covers keep-awake toggles and late inhibitor replies, out-of-order network
proxies, bounded clipboard history, profile/VPN teardown, clipboard row and
artwork reuse, scroll indicator ownership, notification handlers, and shelf
helper restarts. A native GObject signal-group check exercises target disposal.

The checks do not change desktop settings or install the extension. They verify
resource ownership and avoided allocations; they do not benchmark live memory
usage, compositor frame times, or every supported GNOME Shell release.
