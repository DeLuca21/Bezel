import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as LookingGlass from 'resource:///org/gnome/shell/ui/lookingGlass.js';

const XML = `<node><interface name="org.gnome.Shell.Extensions.Bezel.WindowPicker"><method name="Pick"><arg name="windowClass" type="s" direction="out"/></method></interface></node>`;
export class WindowPicker {
    constructor() {
        this.service = Gio.DBusExportedObject.wrapJSObject(XML, this);
        this.service.export(Gio.DBus.session, '/org/gnome/Shell/Extensions/Bezel/WindowPicker');
    }
    PickAsync(_args, invocation) {
        if (this.inspector) {
            invocation.return_dbus_error('org.gnome.Shell.Extensions.Bezel.Busy', 'A window selection is already active');
            return;
        }
        this.invocation = invocation;
        this.glass = Main.createLookingGlass();
        this.glass.open();
        this.glass.hide();
        this.inspector = new LookingGlass.Inspector(this.glass);
        this.outline = new St.Widget({reactive: false, visible: false,
            style: 'border: 3px solid #99c1f1; border-radius: 4px; background-color: transparent;'});
        Main.uiGroup.add_child(this.outline);
        this.inspector._update = event => {
            const [x, y] = event.get_coords();
            const win = this._windowAt(x, y);
            this.inspector._target = win?.get_compositor_private() ?? null;
            this.inspector._pointerTarget = this.inspector._target;
            this.outline.visible = Boolean(win);
            if (win) {
                const rect = win.get_frame_rect();
                this.outline.set_position(rect.x, rect.y);
                this.outline.set_size(rect.width, rect.height);
            }
            this.inspector._displayText.text = win
                ? `${win.get_title() || win.get_wm_class()} — click to select · Esc to cancel`
                : 'Point at an application window · Esc to cancel';
        };
        this.inspector.connect('target', (_inspector, _target, x, y) => {
            this._finish(this._windowAt(x, y)?.get_wm_class() ?? '');
        });
        this.inspector.connect('closed', inspector => {
            this._finish('');
            this.outline?.destroy();
            this.outline = null;
            this.inspector = null;
            inspector.destroy();
            this.glass?.close();
            this.glass = null;
        });
    }
    _windowAt(x, y) {
        const windows = global.display.sort_windows_by_stacking(global.get_window_actors()
            .filter(actor => actor.visible && !actor.meta_window.minimized && actor.meta_window.showing_on_its_workspace())
            .map(actor => actor.meta_window)).reverse();
        return windows.find(win => {
            if (![Meta.WindowType.NORMAL, Meta.WindowType.DIALOG, Meta.WindowType.MODAL_DIALOG].includes(win.get_window_type())) return false;
            const rect = win.get_frame_rect();
            return x >= rect.x && y >= rect.y && x < rect.x + rect.width && y < rect.y + rect.height;
        });
    }
    _finish(value) {
        this.invocation?.return_value(new GLib.Variant('(s)', [value]));
        this.invocation = null;
    }
    destroy() {
        this._finish('');
        this.inspector?._close();
        this.glass?.close();
        this.service.unexport();
    }
}
