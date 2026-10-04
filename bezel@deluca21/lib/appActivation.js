import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export function appWindows(app) {
    const all = app?.get_windows() ?? [];
    const normal = all.filter(win => !win.skip_taskbar);
    return (normal.length ? normal : all).sort((a, b) => b.get_user_time() - a.get_user_time());
}

export function activateApp(app, newWindow = false) {
    if (!app) throw new Error('Application is no longer installed');
    if (newWindow) { app.open_new_window(-1); return; }
    const win = appWindows(app)[0];
    if (win) Main.activateWindow(win);
    else app.activate();
}

// Keep a stable order during a run of clicks: activating a window changes MRU order.
export function appClickHandler(app, mode, showWindows) {
    let cycle = [], last = null;
    return () => {
        const windows = appWindows(app);
        if (!windows.length) { cycle = []; last = null; activateApp(app); return; }
        const focused = windows.find(win => win.has_focus());
        if (mode === 'previews' && windows.length > 1) { showWindows(); return; }
        if (mode === 'minimize') {
            const workspace = global.workspace_manager.get_active_workspace();
            const local = windows.filter(win => win.located_on_workspace(workspace));
            if (focused) local.forEach(win => win.minimize());
            else {
                const target = windows[0];
                const group = windows.filter(win => win.located_on_workspace(target.get_workspace()));
                for (const win of group.slice().reverse()) Main.activateWindow(win);
            }
            return;
        }
        if (mode !== 'cycle' || !focused) { cycle = windows; last = windows[0]; activateApp(app); return; }
        if (focused !== last || cycle.length !== windows.length || cycle.some(win => !windows.includes(win))) cycle = windows;
        const index = cycle.indexOf(focused);
        last = cycle[(index + 1) % cycle.length];
        Main.activateWindow(last);
    };
}
