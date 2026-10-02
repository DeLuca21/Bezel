# Sidebar integration regression

`sidebar-hit-testing.js` needs a real GNOME Shell/Clutter stage. It checks
pointer picking and drawer activation across 40 layout/edit combinations.
The original padding-based layout fails on the status button with Apps present.

Run in a disposable Shell session started with `GSETTINGS_BACKEND=memory`,
with Bezel enabled and its settings window closed. Do not use your desktop
session. From that Shell's Looking Glass evaluator, run (adjust the path):

```js
import('file:///absolute/path/to/Bezel/test/sidebar-hit-testing.js').then(m => m.run(Main.extensionManager.lookup('bezel@deluca21').stateObj._overlay)).then(result => log(JSON.stringify(result))).catch(logError)
```

A successful run logs 40 case names. Failures identify the layout and control.
The test refuses to run without the memory settings backend and restores the
initial configuration on completion or failure.
