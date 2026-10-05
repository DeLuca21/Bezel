# Session animation checks

Run from the repository root with GJS, Cairo and GdkPixbuf available:

```sh
gjs -m tests/login-animation.js
gjs -m tests/session-motion.js
glib-compile-schemas --strict --dry-run bezel@deluca21/schemas
```

The login suite executes the animation controller with controlled Shell actors
and the real Cairo painter. It covers all six styles, all edge subsets,
framed and frameless layouts, autohide preservation, speed and reduced motion,
startup timing, cancellation, actor replacement and restored transforms. Its
1,152 layout combinations span landscape and portrait monitors, and 720 pixel
comparisons check exact handoff to the normal frame. It also verifies the
1920 × 1080 raster-pixel budget per monitor, including HiDPI scaling.

The session suite simulates lock and unlock mode changes, shield visibility,
rapid relock, enabling while locked, custom user modes, greeter exclusion,
monitor changes, independent trigger settings and signal cleanup.

These checks do not exercise PAM authentication or measure live memory use,
compositor frame time or compatibility with every supported GNOME release.

For a manual check in a disposable GNOME session, enable a trigger under
Opening & motion > Session animations, select a style and preview it. Check
framed and frameless layouts, multiple monitors and autohide bars, then test
login, lock and unlock independently. All triggers default to off. With system
animations disabled, playback should be skipped. The desktop should remain
visible while startup prepares, and disabling the extension should restore
actors and remove all temporary surfaces.

Optional render outputs:

```sh
gjs -m tests/login-animation.js --render
gjs -m tests/login-animation.js --render-themes
gjs -m tests/login-animation.js --render-motion
```

These write previews beneath /tmp using the real drawing and animation code.
