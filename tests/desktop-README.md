# Desktop regression checks

Run from the repository root:

```sh
gjs -m tests/performance-regressions.js
gjs -m tests/frame-rendering.js
gjs -m tests/drawer-motion.js
gjs -m tests/motion-audit-regressions.js
gjs -m tests/shell-audit-regressions.js
```

These checks execute the extension methods with simulated Shell actors and a controlled clock, plus the real Cairo painter. They cover shared dashboard sampling and interrupted page transitions, media and native indicator cleanup, popup cancellation, profile naming, stable frame surfaces, drawer/autohide reversals and reduced motion, notification overlap, icon geometry allocation, dock icon reuse, focused window titles, clocks, calendar layout and hover cancellation.

The Cairo suite compares 140 cached/full-reference images. These tests measure correctness and avoided work; they do not measure live desktop memory or GPU frame time. Real actor allocation, calendar alignment and pointer picking are covered by the separately prepared isolated Shell integration harness.
