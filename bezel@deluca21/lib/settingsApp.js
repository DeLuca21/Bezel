import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import {SettingsWindow} from './settings.js';

const directory = ARGV[0];
const source = Gio.SettingsSchemaSource.new_from_directory(`${directory}/schemas`, Gio.SettingsSchemaSource.get_default(), false);
const settings = new Gio.Settings({settings_schema: source.lookup('org.gnome.shell.extensions.bezel', true)});
const application = new Adw.Application({application_id: 'io.github.deluca21.Bezel.Settings'});
let editor = null;
application.connect('activate', () => {
    if (!editor) {
        editor = new SettingsWindow(application, settings, directory);
        editor.window.connect('close-request', () => { editor = null; return false; });
    }
    editor.open(settings.get_int('preferences-bar'));
});
application.run([]);
