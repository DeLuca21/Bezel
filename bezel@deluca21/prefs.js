import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {launchSettings} from './lib/settingsLauncher.js';

export default class BezelPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup({title: 'Opening Bezel settings…'});
        page.add(group);
        window.add(page);
        try {
            launchSettings(this.path);
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => { window.close(); return GLib.SOURCE_REMOVE; });
        } catch (error) {
            group.title = 'Could not open Bezel settings';
            group.description = error.message;
        }
    }
}
