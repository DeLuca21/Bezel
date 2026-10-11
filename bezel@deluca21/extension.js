import {WindowPicker} from './lib/windowPicker.js';
import {WallpaperPalette} from './lib/wallpaperPalette.js';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import {Dash} from 'resource:///org/gnome/shell/ui/dash.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {OverviewBackground} from './lib/overviewBackground.js';
import {ApplicationBlur} from './lib/appBlur.js';
import {BezelOverlay} from './lib/shell.js';
import {SessionMotion} from './lib/sessionMotion.js';
import {playLockAnimation} from './lib/loginAnimation.js';
import {launchSettings} from './lib/settingsLauncher.js';

export default class BezelExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._wallpaperPalette = new WallpaperPalette(this._settings);
        this._startupOverviewHandled = false;
        try {
            this._sessionMotion = new SessionMotion(this._settings,
                () => this._enableDesktop(), () => this._disableDesktop(),
                () => this._overlay?.previewLoginAnimation(),
                () => playLockAnimation(this._settings));
        } catch (error) {
            this.disable();
            throw error;
        }
    }

    disable() {
        this._wallpaperPalette?.destroy();
        this._wallpaperPalette = null;
        this._sessionMotion?.destroy();
        this._sessionMotion = null;
        this._disableDesktop();
        this._settings = null;
    }

    _enableDesktop() {
        if (this._overlay) return;
        this._settingsId = this._settings.connect('changed::hide-gnome-panel', () => {
            this._applyPanel();
        });
        try {
            this._overlay = new BezelOverlay(this._settings, () => launchSettings(this.path));
            this._overviewBackground = new OverviewBackground(this._settings);
            this._applicationBlur = new ApplicationBlur(this._settings);
            this._windowPicker = new WindowPicker();
            this._applyPanel();
            this._superSetting = this._settings.connect('changed::super-launcher', () => this._syncSuper());
            this._syncSuper();
            this._shortcutSignals = ['launcher-shortcut', 'overview-shortcut'].map(key =>
                this._settings.connect(`changed::${key}`, () => this._syncShortcuts()));
            this._syncShortcuts();
            this._dashSetting = this._settings.connect('changed::hide-overview-dock', () => this._syncOverviewDash());
            this._syncOverviewDash();
            if (!this._startupOverviewHandled && Main.layoutManager._startingUp) {
                this._startupOverviewHandled = true;
                if (this._settings.get_boolean('disable-startup-overview')) {
                    this._startupHasOverview = Main.sessionMode.hasOverview;
                    Main.sessionMode.hasOverview = false;
                }
                this._startupOverviewSignal = Main.layoutManager.connect('startup-complete', () => {
                    Main.layoutManager.disconnect(this._startupOverviewSignal);
                    this._startupOverviewSignal = 0;
                    this._restoreStartupOverview();
                    if (!this._settings.get_boolean('disable-startup-overview')) return;
                    this._startupOverviewIdle = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                        this._startupOverviewIdle = 0;
                        Main.overview.hide();
                        return GLib.SOURCE_REMOVE;
                    });
                });
            } else if (!this._startupOverviewHandled) {
                // Shell can enable extensions after its startup animation.
                this._startupOverviewHandled = true;
                if (this._settings.get_boolean('disable-startup-overview'))
                    Main.overview.hide();
            }
        } catch (error) {
            this.disable();
            throw error;
        }
    }

    _disableDesktop() {
        this._restoreStartupOverview();
        if (this._startupOverviewSignal) {
            Main.layoutManager.disconnect(this._startupOverviewSignal);
            this._startupOverviewSignal = 0;
        }
        if (this._startupOverviewIdle) {
            GLib.source_remove(this._startupOverviewIdle);
            this._startupOverviewIdle = 0;
        }
        if (!this._overlay && !this._settingsId) return;
        this._windowPicker?.destroy();
        this._windowPicker = null;
        this._applicationBlur?.destroy();
        this._applicationBlur = null;
        this._overviewBackground?.destroy();
        this._overviewBackground = null;
        this._restoreOverviewDash();
        if (this._dashSetting) {
            this._settings.disconnect(this._dashSetting);
            this._dashSetting = 0;
        }
        for (const id of this._shortcutSignals ?? []) this._settings.disconnect(id);
        this._shortcutSignals = [];
        this._removeShortcuts();
        this._restoreInputShortcut();
        this._restoreSuper();
        if (this._superSetting) {
            this._settings.disconnect(this._superSetting);
            this._superSetting = 0;
        }
        this._overlay?.destroy();
        this._overlay = null;
        if (this._settingsId) {
            this._settings.disconnect(this._settingsId);
            this._settingsId = 0;
        }
        this._restorePanel();
    }

    _restoreStartupOverview() {
        if (this._startupHasOverview === undefined) return;
        if (!Main.sessionMode.hasOverview)
            Main.sessionMode.hasOverview = this._startupHasOverview;
        this._startupHasOverview = undefined;
    }

    _syncOverviewDash() {
        if (!this._settings.get_boolean('hide-overview-dock')) {
            this._restoreOverviewDash();
            return;
        }
        if (this._overviewDash) return;
        const dash = Main.overview.dash;
        // Do not hide a replacement supplied by another dock extension.
        if (!dash || dash.constructor.$gtype !== Dash.$gtype) return;
        const record = {dash, visible: dash.visible,
            min: dash.min_height, natural: dash.natural_height,
            minSet: dash.min_height_set, naturalSet: dash.natural_height_set};
        this._overviewDash = record;
        record.visibility = dash.connect('notify::visible', () => {
            if (dash.visible) dash.hide();
        });
        record.destroy = dash.connect('destroy', () => { this._overviewDash = null; });
        // Remove the empty strip in the overview as well as its painted icons.
        dash.height = 0;
        dash.hide();
    }

    _restoreOverviewDash() {
        const record = this._overviewDash;
        if (!record) return;
        this._overviewDash = null;
        const {dash} = record;
        dash.disconnect(record.visibility);
        dash.disconnect(record.destroy);
        dash.min_height = record.min;
        dash.natural_height = record.natural;
        dash.min_height_set = record.minSet;
        dash.natural_height_set = record.naturalSet;
        dash.visible = record.visible;
    }

    _removeShortcuts() {
        for (const key of this._registeredShortcuts ?? []) Main.wm.removeKeybinding(key);
        this._registeredShortcuts = [];
    }

    _restoreInputShortcut() {
        if (!this._settings) return;
        const wm = new Gio.Settings({schema_id: 'org.gnome.desktop.wm.keybindings'});
        try {
            const records = JSON.parse(this._settings.get_string('shortcut-overrides'));
            for (const {key, original, applied} of records) {
                if (!['switch-input-source', 'switch-input-source-backward'].includes(key)) continue;
                // Preserve any change made by the user while Bezel was active.
                if (JSON.stringify(wm.get_strv(key)) === JSON.stringify(applied)) wm.set_strv(key, original);
            }
        } catch { /* Ignore damaged recovery data. */ }
        this._settings.set_string('shortcut-overrides', '[]');
    }

    _syncShortcuts() {
        this._removeShortcuts();
        this._restoreInputShortcut();
        const keys = ['launcher-shortcut', 'overview-shortcut'];
        const requested = keys.flatMap(key => this._settings.get_strv(key)).map(value => value.toLowerCase());
        const wm = new Gio.Settings({schema_id: 'org.gnome.desktop.wm.keybindings'});
        const records = [];
        for (const key of ['switch-input-source', 'switch-input-source-backward']) {
            const original = wm.get_strv(key);
            const applied = original.filter(value => !requested.includes(value.toLowerCase()));
            if (original.length !== applied.length && wm.is_writable(key)) records.push({key, original, applied});
        }
        this._settings.set_string('shortcut-overrides', JSON.stringify(records));
        for (const {key, applied} of records) wm.set_strv(key, applied);
        for (const key of keys) {
            if (!this._settings.get_strv(key).length) continue;
            const action = Main.wm.addKeybinding(key, this._settings, Meta.KeyBindingFlags.NONE,
                Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW, () => {
                    if (key === 'launcher-shortcut') this._overlay?.toggleLauncher();
                    else {
                        this._overlay?._bars.forEach(bar => bar._close());
                        Main.overview.toggle();
                    }
                });
            if (action !== Meta.KeyBindingAction.NONE) this._registeredShortcuts.push(key);
        }
    }

    _syncSuper() {
        this._restoreSuper();
        if (!this._settings.get_boolean('super-launcher'))
            return;
        this._originalSuper = GObject.signal_handler_find(global.display, {signalId: 'overlay-key'});
        if (this._originalSuper)
            GObject.signal_handler_block(global.display, this._originalSuper);
        this._superHandler = global.display.connect('overlay-key', () => this._overlay?.toggleLauncher());
    }

    _restoreSuper() {
        if (this._superHandler)
            global.display.disconnect(this._superHandler);
        this._superHandler = 0;
        if (this._originalSuper && GObject.signal_handler_is_connected(global.display, this._originalSuper))
            GObject.signal_handler_unblock(global.display, this._originalSuper);
        this._originalSuper = 0;
    }

    _applyPanel() {
        if (this._settings.get_boolean('hide-gnome-panel'))
            this._hidePanel();
        else
            this._restorePanel();
    }

    _hidePanel() {
        if (this._panelWasVisible === undefined)
            this._panelWasVisible = Main.panel.visible;
        Main.panel.add_style_class_name('bezel-collapsed-panel');
        Main.panel.hide();
    }

    _restorePanel() {
        Main.panel.remove_style_class_name('bezel-collapsed-panel');
        if (this._panelWasVisible)
            Main.panel.show();
        this._panelWasVisible = undefined;
    }
}
