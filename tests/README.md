# Performance regressions

Run these checks from the repository root:

```sh
gjs -m tests/performance-regressions.js
gjs -m tests/frame-rendering.js
gjs -m tests/login-animation.js
gjs -m tests/session-motion.js
gjs -m tests/drawer-motion.js
```

The first uses actual extension code with simulated Shell actors and a controlled
clock. It checks dashboard timer sampling and interrupted transitions, media and
native list cleanup, indicator restoration, asynchronous popup cancellation,
profile naming, settings routing and stable frame surfaces during autohide.
The rendering test compares cached frame regions with a full Cairo reference
across all edges, drawers, notification corners and cramped monitor sizes.
It allows the small antialiasing differences present when Cairo curves are
clipped into separate surfaces.

The login test also checks a maximum of 1920 × 1080 raster pixels per monitor,
including HiDPI scaling, and a single paint for Desktop Fade. Edge Glide and Soft Fade reuse their raster
until the frame geometry or a notification changes. Larger displays
scale the temporary login texture; the normal frame retains native resolution.
These isolated checks do not measure compositor/GPU frame time or establish
visual quality in a live GNOME session.

# Animation styles

Stored animation IDs stay stable when their display names change.

| Style | Stored ID | Motion |
| --- | --- | --- |
| Edge Bloom (formerly Liquid) | `liquid` | Frame spreads from edge centres; icons arrive in a wave. |
| Split Reveal (formerly Curtain) | `curtain` | Desktop opens horizontally from its centre. |
| Top-down Sweep (formerly Cascade) | `cascade` | Desktop opens downwards with staggered bars. |
| Desktop Fade (formerly Fade) | `fade` | A desktop cover fades away. |
| Edge Glide (new) | `glide` | Bars approach their edges gently while the frame fades in. |
| Soft Fade (new) | `soft-fade` | Frame and bars fade in without displacement or a desktop cover. |

All styles preserve icon proportions, existing actor transforms, autohide state,
and changes to app buttons during startup. The settings dropdown includes a
short explanation of each style. The duration setting now applies to drawers
and both joined and floating autohide bars; zero disables those transitions.
Launcher resizing, dashboard transitions, drawers and bars respect reduced motion.
GNOME's native hover/focus colour transitions remain managed by St.

# Login animation regression

Run `gjs -m tests/login-animation.js` from the repository root. It uses the real
Cairo painter with simulated Shell actors to check multiple monitors, all bar
edges, framed and frameless layouts, autohide preservation, reduced motion,
completion, cancellation and startup timeout cleanup.
The Edge Bloom checks cover a clear first paint and fixed desktop geometry on portrait and ultrawide screens,
restrained approach on all four edges, undistorted icons and the wave from centre to ends,
replacement app buttons during startup, and restoration of existing transforms.
They also check restoration of the underlying frame on cancellation and compare
the completed Edge Bloom paint with the static frame pixel for pixel.
It also checks that waiting for startup leaves the desktop visible, that the
reveal begins at `startup-prepared`, and that late startup and cancellation
remove both startup signal handlers.

`--render` writes an Edge Bloom contact sheet to `/tmp/bezel-liquid-preview.png`;
`--render-themes` compares all six styles. `--render-motion` writes 56 frames
to `/tmp/bezel-edge-frames`, with representative icons on a rail and floating
dock, using the actual Cairo painter and animation curves.

For visual verification in a disposable GNOME session, enable **Opening &
motion > Animate login**, choose **Edge Bloom**, then log out and back in. Check a left rail,
top bar plus dock, floating bars, and multiple monitors. The desktop should
remain visible while the frame paints from each edge centre towards its corners.
The default reveal takes 1.1 seconds, with no central graphic or moving desktop
opening. Icons should retain their natural proportions and spacing as the bars
stretch, then arrive with a subtle wave from the centre towards the ends. The
motion should settle without bouncing. Disabling the
toggle or system animations should restore immediate startup. Unlocking replays
the reveal only with **Animate unlock** enabled; editing the layout does not.

The login suite covers 1,152 combinations: all six styles × all 16 edge subsets
(including a frame without bars) × six bar variants × framed/frameless. Each
combination runs across landscape and portrait monitors with negative origins
and a top-panel inset. Variants include full/partial panels, docks, floating
panels, autohide and mixed layouts. Nested groups with existing transforms,
reparented/destroyed actors, interrupted startup, reduced motion during playback,
and dynamic frame cache invalidation are included. Another 720 comparisons verify
pixel-exact frame handoffs for every non-cover style, edge subset, drawer edge
and notification corner. HiDPI and ultrawide checks remain in the same suite.

`drawer-motion.js` checks the real transition methods across 16 combinations
of edges, joined/floating autohide and attached/floating drawers. It verifies
reversal, anchoring, immediate completion, zero duration and launcher resize
cancellation under reduced motion.

# Isolated GNOME Shell integration

```sh
python3 tests/run-motion-shell.py
```

This requires GNOME Shell with headless Wayland support, GJS, Python 3,
`dbus-run-session` and `glib-compile-schemas`. The runner copies the extension
into a temporary directory, uses a private D-Bus session and memory settings,
and creates landscape and portrait virtual monitors. It stops only its own
process group and leaves logs, a JSON result and six screenshots in the printed
temporary directory. The installed extension and desktop settings are untouched.

`motion-integration.js` checks 180 real actor login combinations, 72 drawer
edge/location/frame combinations, eight autohide reversal cases, and 48 Wi-Fi
placement cases. Wi-Fi must remain anchored to its own sidebar button with either
global or per-module edge volume controls, on both monitors and all four edges. The runner
then performs the 40 sidebar picking tests below. Screenshots sample every style
with four mixed bars across both monitors. This validates real allocations,
clipping and cleanup on the installed GNOME version, not GPU frame-time budgets
or every supported Shell release. Startup signal timing is covered separately
by the controlled lifecycle tests above.

# Sidebar integration regression

## Late-loading icons

Run `python3 tests/run-motion-shell.py --startup-only` to check Power, Wi-Fi and
Bluetooth bar icons after their natural sizes change. Eight cases cover panels
and docks on all four edges, checking the full clickable icon area, shrinkage
and settled layout. The test reproduces clipped icons without the content-size
watcher. The full isolated Shell run includes these checks. The controlled
`shell-audit-regressions.js` suite also verifies event coalescing and teardown.

## Scroll decoration alignment

Run `python3 tests/run-motion-shell.py --overflow-only` to check the scroll fades
and marker in an isolated Shell. It verifies 18 combinations of viewport size,
scroll position and marker visibility, plus hiding decorations when content fits.
The screenshot also allows checking that the fade blends into the menu colour
without a dark band. The full integration runner includes these checks.

## Calendar alignment

Run `python3 tests/run-motion-shell.py --calendar-only` for a focused calendar
check in the same isolated Shell. It compares rendered text bounds with date
column centres in 48 cases: all four sidebar edges, four dashboard sizes,
week numbers on/off, and current/next/previous months. It captures drawer and
dashboard screenshots. This catches the fixed-width `St.Label` issue where
centred actor or Pango alignment still leaves single-line weekday text offset.
The full integration runner includes these checks too.

## Pointer picking

`sidebar-hit-testing.js` needs a real GNOME Shell/Clutter stage. It checks
pointer picking and drawer activation across 40 layout/edit combinations.
It selects the actual buttons inside layout wrappers and checks that grouped
status controls retain their click handlers. The original padding-based layout
fails on the status button with Apps present.

Run in a disposable Shell session started with `GSETTINGS_BACKEND=memory`,
with Bezel enabled and its settings window closed. Do not use your desktop
session. From that Shell's Looking Glass evaluator, run (adjust the path):

```js
import('file:///absolute/path/to/Bezel/tests/sidebar-hit-testing.js').then(m => m.run(Main.extensionManager.lookup('bezel@deluca21').stateObj._overlay)).then(result => log(JSON.stringify(result))).catch(logError)
```

A successful run logs 40 case names. Failures identify the layout and control.
The test refuses to run without the memory settings backend and restores the
initial configuration on completion or failure.

# Lock and unlock animations

`gjs -m tests/session-motion.js` checks independent trigger options, repeated
lock/unlock cycles, shield visibility ordering, rapid relock, enabling while
locked, greeter exclusion, custom user modes, monitor changes and signal cleanup.

`python3 tests/run-motion-shell.py --session-only` checks 24 real Shell session
mode cycles (six styles × four lock/unlock option combinations) on two monitors,
plus disabled system animations. It verifies removal of desktop actors and
shortcuts, lock surfaces parented to the shield without input handling, the
transient frame’s fade-out, deferred unlock playback and cleanup. It simulates
shield visibility and session modes inside the disposable Shell; it does not
exercise PAM authentication or lock the user's actual desktop. The full runner
includes this check after the existing suites.

# Whole-code audit regressions

```sh
gjs -m tests/shell-audit-regressions.js
gjs -m tests/lifecycle-regressions.js
gjs -m tests/motion-audit-regressions.js
gjs -m tests/launcher-settings-regressions.js
```

These exercise actual extension methods with controlled actors and async replies.
They cover dock icon reuse, hover cancellation, focused-window title changes,
clock/calendar allocation work, rebuild-source cleanup, keep-awake and network
races, clipboard bounds, service/proxy/process teardown, scroll hints, notification
handlers, shelf helper restarts, interrupted layout transitions, app icon geometry,
launcher row reuse and search ranking, and settings/folder cleanup. The launcher
suite also enumerates a temporary directory using real asynchronous Gio calls.
Clipboard history skips entries longer than 65,536 characters and retains at most
40 entries; the system clipboard itself is unchanged.

Allocation, query and repaint counts are deterministic regression checks, not
measurements of live desktop memory use or GPU frame time. Run the isolated Shell
integration suite above to verify real actors and layouts after these checks.
The runner also fails on extension GJS critical/error stack traces, including
native-object lifetime errors that do not reject the test promise.

# Local installer regression

Run `python3 tests/install-local.py`. Four tests use temporary repositories and data directories to verify installation, replacement backups, invalid-schema preservation, symlink protection and UUID validation. They never replace your installed extension.

# Text rendering

Run `python3 tests/run-motion-shell.py --text-only` for real Shell allocation
checks on four edges and two monitors. Percentage-length panels and docks,
odd-height popouts, settled scales, and the font used for vertical captions
are checked. The original placement fails with a bar at 116.03 pixels.
The isolated runner saves a native-resolution `text-rendering.png` for visual
inspection and leaves desktop font and display settings untouched.
