import Gio from 'gi://Gio';

// The custom editor lives in its own GTK process so Mutter can manage it normally.
export function launchSettings(path) {
    return Gio.Subprocess.new(['gjs', '-m', `${path}/lib/settingsApp.js`, path], Gio.SubprocessFlags.NONE);
}
