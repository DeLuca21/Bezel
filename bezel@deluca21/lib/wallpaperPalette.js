import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GdkPixbuf from 'gi://GdkPixbuf';
import {extractSwatches, wallpaperTheme} from './wallpaperColors.js';

// Decode a bounded sample asynchronously, including when the wallpaper is large.
export class WallpaperPalette {
    constructor(settings) {
        this.settings = settings;
        this.background = new Gio.Settings({schema_id: 'org.gnome.desktop.background'});
        this.interface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this.signals = [[settings, settings.connect('changed', (_, key) => {
            if (['theme', 'wallpaper-swatch', 'wallpaper-variant', 'wallpaper-style'].includes(key)) this.queue();
        })], ...[this.background, this.interface].map(s => [s, s.connect('changed', () => this.queue())])];
        this.queue();
    }
    queue() {
        this.cancel?.cancel();
        if (this.timer) GLib.source_remove(this.timer);
        this.timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
            this.timer = 0; this.update(); return GLib.SOURCE_REMOVE;
        });
    }
    async update() {
        if (this.settings.get_string('theme') !== 'wallpaper') {
            this.monitor?.cancel(); this.monitor = null; this.uri = null; return;
        }
        const cancel = this.cancel = new Gio.Cancellable();
        const style = this.settings.get_string('wallpaper-style');
        const light = style === 'light' || (style === 'system' && this.interface.get_string('color-scheme') !== 'prefer-dark');
        const uri = (!light && this.background.get_string('picture-uri-dark')) || this.background.get_string('picture-uri');
        let stream;
        try {
            if (!uri) throw new Error('No wallpaper selected');
            const file = Gio.File.new_for_uri(uri);
            if (!file.is_native()) throw new Error('Wallpaper must be a local image');
            if (uri !== this.uri) {
                this.monitor?.cancel(); this.monitor = null; this.uri = uri;
                try { this.monitor = file.monitor_file(Gio.FileMonitorFlags.NONE, null);
                    this.monitor.connect('changed', () => this.queue()); } catch { /* Still sample readable files. */ }
            }
            stream = await new Promise((resolve, reject) => file.read_async(GLib.PRIORITY_DEFAULT, cancel, (f, r) => {
                try { resolve(f.read_finish(r)); } catch (e) { reject(e); }
            }));
            const sample = await new Promise((resolve, reject) => GdkPixbuf.Pixbuf.new_from_stream_at_scale_async(stream, 96, 96, true, cancel, (_, r) => {
                try { resolve(GdkPixbuf.Pixbuf.new_from_stream_finish(r)); } catch (e) { reject(e); }
            }));
            if (cancel.is_cancelled()) return;
            const swatches = extractSwatches(sample.get_pixels(), sample.width, sample.height, sample.rowstride, sample.n_channels);
            if (!swatches.length) throw new Error('Wallpaper contains no visible colours');
            const index = this.settings.get_int('wallpaper-swatch');
            const score = hex => {
                const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
                return (Math.max(...c) - Math.min(...c)) * (1 - Math.abs((Math.max(...c) + Math.min(...c)) / 2 - .5));
            };
            const automatic = [...swatches].sort((a, b) => score(b) - score(a))[0];
            const source = swatches[index] ?? automatic;
            const theme = wallpaperTheme(source, light, this.settings.get_string('wallpaper-variant'));
            const data = JSON.stringify({theme, swatches});
            if (data !== this.settings.get_string('wallpaper-palette')) this.settings.set_string('wallpaper-palette', data);
            this.settings.set_string('wallpaper-status', '');
        } catch (e) {
            if (!cancel.is_cancelled()) {
                console.warn(`Bezel wallpaper palette: ${e.message}`);
                this.settings.set_string('wallpaper-status', 'Could not read wallpaper colours. Keeping the previous palette.');
            }
        } finally { if (stream) try { stream.close(null); } catch {} }
    }
    destroy() {
        this.cancel?.cancel(); this.monitor?.cancel();
        if (this.timer) GLib.source_remove(this.timer);
        for (const [s, id] of this.signals) s.disconnect(id);
    }
}
