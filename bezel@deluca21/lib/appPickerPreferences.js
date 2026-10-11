import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

export function appPickerList(settings, key, window) {
    const title = key.endsWith('whitelist') ? 'Whitelist' : 'Blacklist';
    const group = new Adw.PreferencesGroup({title, description: title === 'Whitelist' ? 'Applications to blur.' : 'Applications to exclude from blur.'});
    const add = new Gtk.Button({label: '+ Add Window', valign: Gtk.Align.CENTER});
    add.add_css_class('flat');
    group.set_header_suffix(add);
    const status = new Gtk.Label({wrap: true, xalign: 0, visible: false});
    let entries = [];
    let pending = null;
    const save = () => settings.set_strv(key, entries.map(item => item.entry.text.trim()).filter(Boolean));
    const pick = row => {
        status.visible = false;
        Gio.DBus.session.call('org.gnome.Shell', '/org/gnome/Shell/Extensions/Bezel/WindowPicker',
            'org.gnome.Shell.Extensions.Bezel.WindowPicker', 'Pick', null, null,
            Gio.DBusCallFlags.NONE, -1, null, (connection, result) => {
                try {
                    const [value] = connection.call_finish(result).deep_unpack();
                    if (value) { row.entry.text = value; pending = null; save(); }
                    else { status.label = 'No application selected. Click the pointer button to try again.'; status.visible = true; }
                } catch (error) {
                    status.label = 'Window picker unavailable. Reload Bezel by logging out and back in.';
                    status.visible = true;
                    console.error(error);
                }
                window.present();
            });
    };
    const append = value => {
        const row = new Adw.ExpanderRow({title: value || 'Select window', expanded: !value});
        const remove = new Gtk.Button({icon_name: 'window-close-symbolic', valign: Gtk.Align.CENTER, tooltip_text: `Remove ${value || 'entry'}`});
        remove.add_css_class('flat');
        row.add_prefix(remove);
        const selector = new Adw.ActionRow({title: 'Select window', subtitle: 'Pick a window or enter its class name.'});
        const button = new Gtk.Button({child: new Gtk.Image({gicon: new Gio.FileIcon({file: Gio.File.new_for_uri(GLib.uri_resolve_relative(import.meta.url, '../icons/window-picker-symbolic.svg', GLib.UriFlags.NONE))})}), tooltip_text: 'Select window', valign: Gtk.Align.CENTER});
        button.add_css_class('flat');
        const entry = new Gtk.Entry({text: value, width_chars: 18, valign: Gtk.Align.CENTER});
        selector.add_suffix(button);
        selector.add_suffix(entry);
        row.add_row(selector);
        const item = {row, entry};
        entries.push(item);
        entry.connect('changed', () => { row.title = entry.text || 'Select window'; save(); });
        button.connect('clicked', () => pick(item));
        remove.connect('clicked', () => { entries = entries.filter(candidate => candidate !== item); if (pending === item) pending = null; group.remove(row); save(); });
        group.add(row);
        return item;
    };
    for (const value of settings.get_strv(key)) append(value);
    add.connect('clicked', () => {
        for (const item of entries) item.row.expanded = false;
        pending ??= append('');
        pending.row.expanded = true;
        pick(pending);
    });
    // PreferencesGroup places ordinary widgets after its row list: keeping
    // each list in its own group preserves its header and row ordering.
    group.add(status);
    return group;
}
