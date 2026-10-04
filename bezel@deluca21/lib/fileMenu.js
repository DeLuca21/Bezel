import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import * as Config from 'resource:///org/gnome/shell/misc/config.js';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {chromeOptions} from './compat.js';
import {paintPillBackdrop} from './drawing.js';
import {menuPosition} from './geometry.js';

const MENU_WIDTH = 220;

function pointerCoords(event) {
    const raw = event?.get_coords?.();
    const x = raw?.[raw.length - 2], y = raw?.[raw.length - 1];
    if (Number.isFinite(x) && Number.isFinite(y) && (x > 2 || y > 2))
        return [x, y];
    return global.get_pointer();
}

export function popupChromeMenu(bar, x, y, entries) {
    const theme = bar._theme;
    const depth = Math.max(0, Number(bar._state?.shadow) || 0);
    const wrap = new St.Widget({
        reactive: true, x_expand: false, y_expand: false,
        layout_manager: new Clutter.BinLayout(),
        accessible_name: 'File menu',
    });
    const plate = depth > 0 ? new St.DrawingArea({reactive: false}) : null;
    const box = new St.BoxLayout({
        orientation: Clutter.Orientation.VERTICAL, reactive: true,
        x_expand: false, y_expand: false, width: MENU_WIDTH,
        style: `spacing: 0; padding: 5px; border-radius: 10px; background-color: ${theme.bg}; border: 1px solid ${theme.surface};`,
    });
    if (plate)
        wrap.add_child(plate);
    wrap.add_child(box);
    const shade = new St.Widget({reactive: true, x: 0, y: 0});
    shade.add_constraint(new Clutter.BindConstraint({source: global.stage, coordinate: Clutter.BindCoordinate.SIZE}));
    let closed = false, press = 0;
    const close = () => {
        if (closed) return;
        closed = true;
        if (press) { global.stage.disconnect(press); press = 0; }
        bar._popupAuxActors?.delete(wrap);
        bar._popupAuxActors?.delete(shade);
        try { Main.layoutManager.removeChrome(wrap); } catch {}
        try { Main.layoutManager.removeChrome(shade); } catch {}
        wrap.destroy();
        shade.destroy();
    };
    wrap._bezelCloseOnEscape = close;
    for (const entry of entries) {
        if (entry === 'sep') {
            box.add_child(new St.Widget({height: 1, style: `background-color: ${theme.surface}; margin: 4px 8px;`}));
            continue;
        }
        const item = new St.Button({accessible_name: entry.title, can_focus: true, track_hover: true, x_expand: true});
        const row = new St.BoxLayout({style: 'spacing: 10px;', x_expand: true});
        row.add_child(new St.Icon({icon_name: entry.icon, icon_size: 16}));
        row.add_child(new St.Label({text: entry.title, x_expand: true, x_align: Clutter.ActorAlign.START}));
        row.add_child(new St.Label({text: entry.shortcut || '', style: `color: ${theme.muted}; font-size: 11px;`, y_align: Clutter.ActorAlign.CENTER}));
        item.set_child(row);
        const style = () => { item.style = `padding: 8px 10px; border-radius: 6px; background-color: ${item.hover || item.has_key_focus() ? theme.surface : 'transparent'}; color: ${theme.fg};`; };
        item.connect('notify::hover', style); item.connect('key-focus-in', style); item.connect('key-focus-out', style); style();
        item.connect('clicked', () => { close(); entry.run(); });
        box.add_child(item);
    }
    Main.layoutManager.addChrome(shade, chromeOptions(Config.PACKAGE_VERSION, true, false, false));
    Main.layoutManager.addChrome(wrap, chromeOptions(Config.PACKAGE_VERSION, true, false, false));
    const parent = shade.get_parent();
    if (parent && wrap.get_parent() === parent)
        parent.set_child_below_sibling(shade, wrap);
    shade.connect('button-press-event', () => {
        close();
        return Clutter.EVENT_STOP;
    });
    shade.connect('touch-event', (_actor, event) => {
        if (event.type() === Clutter.EventType.TOUCH_BEGIN) close();
        return Clutter.EVENT_STOP;
    });
    const [, height] = box.get_preferred_height(MENU_WIDTH);
    wrap.set_size(MENU_WIDTH + depth * 2, height + depth * 2);
    box.set_position(depth, depth);
    box.set_size(MENU_WIDTH, height);
    if (plate) {
        plate.set_size(MENU_WIDTH + depth * 2, height + depth * 2);
        plate.connect('repaint', () => {
            const cr = plate.get_context();
            try {
                const [sw, sh] = plate.get_surface_size();
                const width = plate.width;
                const tall = plate.height;
                if (width <= 0 || tall <= 0)
                    return;
                if (sw > 0 && sh > 0)
                    cr.scale(sw / width, sh / tall);
                paintPillBackdrop(cr, {
                    x: depth, y: depth,
                    w: Math.max(1, width - depth * 2),
                    h: Math.max(1, tall - depth * 2),
                }, 10, theme.bg, 1, depth);
            } finally {
                cr.$dispose();
            }
        });
        plate.queue_repaint();
    }
    wrap.set_position(...menuPosition(bar._monitor, x, y, MENU_WIDTH, height, Math.max(depth, 4)));
    press = global.stage.connect('captured-event', (_stage, event) => {
        if (closed) return Clutter.EVENT_PROPAGATE;
        if (event.type() !== Clutter.EventType.BUTTON_PRESS && event.type() !== Clutter.EventType.TOUCH_BEGIN)
            return Clutter.EVENT_PROPAGATE;
        const [px, py] = event.get_coords();
        const picked = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, px, py);
        if (picked && (wrap === picked || wrap.contains(picked)))
            return Clutter.EVENT_PROPAGATE;
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => { close(); return GLib.SOURCE_REMOVE; });
        return Clutter.EVENT_STOP;
    });
    bar._popupAuxActors?.add(wrap);
    bar._popupAuxActors?.add(shade);
    box.get_first_child()?.grab_key_focus();
    bar._persistPopup();
    return {close, actor: wrap, box};
}

export function menuFromEvent(bar, event, entries) {
    return popupChromeMenu(bar, ...pointerCoords(event), entries);
}
