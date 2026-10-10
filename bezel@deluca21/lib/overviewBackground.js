import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import Meta from 'gi://Meta';
import St from 'gi://St';
import * as Background from 'resource:///org/gnome/shell/ui/background.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {resolveTheme} from './theme.js';

// A wallpaper-only layer inside the overview, below its controls and previews.
// Fullscreen windows cannot obscure it, and it never intercepts input.
export class OverviewBackground {
    constructor(settings) {
        this._settings = settings;
        this._managers = [];
        this._tiles = [];
        this._signals = [];
        // A running Shell may still hold a schema loaded before an update.
        // Leave this optional feature off until the next login in that case.
        if (!['overview-background', 'overview-dim', 'overview-blur',
            'overview-gradient-strength'].every(key => settings.settings_schema.has_key(key)))
            return;
        this._signals = ['overview-background', 'overview-dim', 'overview-blur',
            'overview-gradient-strength', 'theme', 'wallpaper-palette',
            'custom-bg', 'custom-accent'].map(key => settings.connect(`changed::${key}`, () => this._sync()));
        this._monitors = Main.layoutManager.connect('monitors-changed', () => { this._clear(); this._sync(); });
        try {
            this._sync();
        } catch (error) {
            this.destroy();
            throw error;
        }
    }

    _clear() {
        for (const manager of this._managers) manager.destroy();
        this._managers = [];
        this._tiles = [];
        this._actor?.destroy();
        this._actor = null;
    }

    _sync() {
        const mode = this._settings.get_string('overview-background');
        if (mode === 'off') { if (this._actor) this._actor.hide(); return; }
        const group = Main.layoutManager.overviewGroup;
        if (!this._actor) {
            this._actor = new Meta.BackgroundGroup({name: 'bezel-overview-background'});
            group.insert_child_at_index(this._actor, 0);
            for (const monitor of Main.layoutManager.monitors) {
                const tile = new St.Widget({x: monitor.x, y: monitor.y,
                    width: monitor.width, height: monitor.height, reactive: false,
                    clip_to_allocation: true});
                this._actor.add_child(tile);
                // Blur My Shell uses a raised St.Widget per monitor to avoid
                // Mutter's multi-monitor offscreen rendering glitch.
                const wallpaper = new St.Widget({width: monitor.width, height: monitor.height,
                    z_position: 1,
                    layout_manager: new Clutter.BinLayout()});
                tile.add_child(wallpaper);
                const manager = new Background.BackgroundManager({container: wallpaper,
                    monitorIndex: monitor.index, controlPosition: false});
                this._managers.push(manager);
                // Keep the effect on the stable container. GNOME can replace
                // its wallpaper child without reinstalling effects or handlers.
                const blur = new Shell.BlurEffect({mode: Shell.BlurMode.ACTOR, radius: 0, brightness: 1});
                wallpaper.add_effect_with_name('bezel-overview-blur', blur);
                const tint = new St.Widget({width: monitor.width, height: monitor.height, reactive: false});
                tile.add_child(tint);
                this._tiles.push({tile, wallpaper, tint, blur});
            }
        }
        this._actor.show();
        const theme = resolveTheme(this._settings);
        const dim = this._settings.get_int('overview-dim') / 100;
        const strength = this._settings.get_int('overview-gradient-strength') / 100;
        const gradientStart = '#' + [1, 3, 5].map(offset => {
            const base = parseInt(theme.bg.slice(offset, offset + 2), 16);
            const accent = parseInt(theme.accent.slice(offset, offset + 2), 16);
            return Math.round(base + (accent - base) * strength).toString(16).padStart(2, '0');
        }).join('');
        for (const {tile, wallpaper, tint, blur} of this._tiles) {
            const gradient = mode === 'gradient';
            wallpaper.visible = !gradient;
            tint.visible = !gradient;
            tile.style = gradient
                ? `background-color: ${theme.bg}; background-gradient-direction: vertical; background-gradient-start: ${gradientStart}; background-gradient-end: ${theme.bg};`
                : '';
            tint.style = `background-color: rgba(0,0,0,${dim});`;
            blur.radius = this._settings.get_int('overview-blur') * St.ThemeContext.get_for_stage(global.stage).scale_factor;
            blur.enabled = mode === 'blurred';
        }
    }

    destroy() {
        for (const id of this._signals) this._settings.disconnect(id);
        this._signals = [];
        if (this._monitors) Main.layoutManager.disconnect(this._monitors);
        this._monitors = 0;
        this._clear();
    }
}
