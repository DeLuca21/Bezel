import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import {SettingsWindow} from './settings.js';
import {SidebarSettingsWindow} from './settingsSidebar.js';
import GLib from 'gi://GLib';

const directory = ARGV[0];
const source = Gio.SettingsSchemaSource.new_from_directory(`${directory}/schemas`, Gio.SettingsSchemaSource.get_default(), false);
const settings = new Gio.Settings({settings_schema: source.lookup('org.gnome.shell.extensions.bezel', true)});
const application = new Adw.Application({application_id: 'io.github.deluca21.Bezel.Settings'});
let editor = null;
let replacing = false;
function createEditor() {
    const Window = settings.get_string('settings-layout') === 'sidebar' ? SidebarSettingsWindow : SettingsWindow;
    const next = new Window(application, settings, directory);
    editor = next;
    next.window.connect('close-request', () => { if (editor === next) editor = null; return false; });
    return next;
}
settings.connect('changed::settings-layout', () => {
    if (!editor || replacing) return;
    replacing = true;
    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        const previous = editor;
        const next = createEditor();
        const classic = settings.get_string('settings-layout') === 'classic';
        next.mode = classic && !['bar', 'look', 'frame', 'shortcuts', 'opening', 'liquid', 'desktop'].includes(previous.mode) ? 'bar' : previous.mode;
        next.barIndex = previous.barIndex;
        next.barTab = classic && previous.barTab === 'shape' ? 'size' : previous.barTab;
        previous.window.close();
        next.open(next.mode === 'bar' ? next.barIndex : -1);
        replacing = false;
        return GLib.SOURCE_REMOVE;
    });
});
application.connect('activate', () => {
    if (!editor) createEditor();
    editor.open(settings.get_int('preferences-bar'));
});
application.run([]);
