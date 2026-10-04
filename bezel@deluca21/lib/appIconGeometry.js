import Mtk from 'gi://Mtk';

const sameRect = (a, b) => a && b && ['x', 'y', 'width', 'height'].every(key => a[key] === b[key]);

// One owner chooses targets across duplicate icons/bars. Track actual stage geometry,
// including ancestor movement, scroll offsets and autohide; write only on changes.
export class AppIconGeometry {
    constructor() {
        this.entries = new Set();
        this.windows = new Map();
        this.preferred = new Map();
        this.paint = global.stage.connect('after-paint', () => this.sync());
    }

    add(button, app, bar) {
        if (!app) return () => {};
        const entry = {button, app, bar};
        this.entries.add(entry);
        button.connect('destroy', () => {
            this.entries.delete(entry);
            if (this.preferred.get(app) === entry) this.preferred.delete(app);
        });
        return () => { this.preferred.set(app, entry); this.sync(true); };
    }

    rect(entry) {
        const {button, bar} = entry;
        if (!button.get_stage() || !button.mapped || button.width <= 0 || button.height <= 0) return null;
        let [x, y] = button.get_transformed_position();
        let [width, height] = button.get_transformed_size();
        const monitor = bar._monitor;
        let left = monitor.x, top = monitor.y, right = left + monitor.width, bottom = top + monitor.height;
        for (let parent = button.get_parent(); parent && parent !== global.stage; parent = parent.get_parent()) {
            if (!parent.clip_to_allocation) continue;
            const [px, py] = parent.get_transformed_position(), [pw, ph] = parent.get_transformed_size();
            const l = Math.max(left, px), t = Math.max(top, py), r = Math.min(right, px + pw), b = Math.min(bottom, py + ph);
            if (r > l && b > t) { left = l; top = t; right = r; bottom = b; }
        }
        width = Math.max(1, Math.min(width, right - left)); height = Math.max(1, Math.min(height, bottom - top));
        x = Math.max(left, Math.min(x, right - width)); y = Math.max(top, Math.min(y, bottom - height));
        return new Mtk.Rectangle({x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height)});
    }

    sync(force = false) {
        const candidates = new Map();
        for (const entry of this.entries) {
            const rect = this.rect(entry);
            if (!rect) continue;
            for (const win of entry.app.get_windows()) {
                const score = (this.preferred.get(entry.app) === entry ? 4 : 0) + (win.get_monitor() === entry.bar._monitor.index ? 2 : 0);
                if (!candidates.has(win) || score > candidates.get(win).score) candidates.set(win, {entry, rect, score});
            }
        }
        for (const [win, record] of this.windows) if (!candidates.has(win)) this.release(win, record);
        for (const [win, {rect}] of candidates) {
            let record = this.windows.get(win);
            if (!record) {
                const [has, previous] = win.get_icon_geometry();
                record = {previous: has ? previous : null, written: null, signal: win.connect('unmanaged', () => this.windows.delete(win))};
                this.windows.set(win, record);
            }
            if (force || !sameRect(record.written, rect)) { win.set_icon_geometry(rect); record.written = rect; }
        }
    }

    release(win, record) {
        const [has, current] = win.get_icon_geometry();
        // Don't overwrite geometry claimed meanwhile by another dock.
        if (has && sameRect(current, record.written)) win.set_icon_geometry(record.previous);
        win.disconnect(record.signal);
        this.windows.delete(win);
    }

    destroy() {
        global.stage.disconnect(this.paint);
        for (const [win, record] of this.windows) this.release(win, record);
        this.entries.clear(); this.preferred.clear();
    }
}
