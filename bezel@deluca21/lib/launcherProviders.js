import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {filterMatches, scoreItem} from './search.js';
import {PRESETS} from './theme.js';
import {readBars, applyPreset} from './config.js';
import {savedLayouts, restoreLayout, rememberLayout, layoutValues} from './profiles.js';

export function bezelResults(bar) {
    const settings = bar._overlay._settings;
    const open = (page, barIndex = -1, tab = 'contents') => bar._overlay.openSettings({page, barIndex, tab});
    const result = [];
    const add = (name, keywords, page, barIndex, tab) => result.push({name, keywords: `bezel settings options ${keywords}`, detail: 'Open Bezel settings', icon: 'preferences-system-symbolic', run: () => open(page, barIndex, tab)});
    for (const [name, words, page] of [
        ['Themes and colours', 'appearance palette custom', 'look'], ['Layouts and bars', 'presets saved layout', 'bar'],
        ['Screen border', 'frame width radius shadow dashboard notifications position', 'frame'],
        ['Launcher and shortcuts', 'search files folders web engine commands keyboard shortcut launcher width', 'shortcuts'],
        ['Opening and motion', 'animation duration hover delay edge dashboard power', 'opening'],
        ['Desktop options', 'weather hide gnome panel overview dock notifications date time format', 'desktop'],
    ]) add(name, words, page);
    readBars(settings).forEach((item, index) => {
        const name = `${item.edge} ${item.kind} ${index + 1}`;
        for (const [title, words, tab] of [
            ['Behaviour', 'autohide floating reserve space', 'contents'], ['Modules and groups', 'contents add remove reorder', 'contents'],
            ['Size and spacing', 'thickness length margin icon size rounding', 'size'], ['Appearance', 'colour opacity padding', 'appearance'],
            ['App icons', 'hover lift highlight click focused running indicator pins', 'apps'],
        ]) add(`${title} · ${name}`, words, 'bar', index, tab);
    });
    for (const palette of PRESETS) result.push({name: palette.name, keywords: 'bezel theme palette colours appearance',
        detail: `${settings.get_string('theme') === palette.id ? 'Current theme' : 'Apply theme'} · Enter to apply`, icon: 'applications-graphics-symbolic', run: () => settings.set_string('theme', palette.id)});
    const apply = callback => {
        const previous = {name: 'Before launcher layout change', values: layoutValues(settings)};
        settings.set_string('launcher-layout-undo', JSON.stringify(previous));
        callback();
        rememberLayout(settings);
    };
    for (const [id, name] of [['caelestia', 'Bezel'], ['panel', 'Panel'], ['dock', 'Dock'], ['hybrid', 'Top + dock'], ['islands', 'Islands'], ['split', 'Split']])
        result.push({name: `${name} layout`, keywords: 'bezel layout preset', detail: 'Apply layout · previous setup available through Undo layout', icon: 'view-grid-symbolic', run: () => apply(() => applyPreset(settings, id))});
    for (const profile of savedLayouts(settings)) result.push({name: profile.name, keywords: 'bezel saved layout', detail: 'Load saved layout · restores its settings', icon: 'document-open-symbolic', run: () => apply(() => restoreLayout(settings, profile))});
    if (settings.get_string('launcher-layout-undo')) result.push({name: 'Undo layout change', keywords: 'bezel restore previous layout', detail: 'Restore setup before the last launcher layout change', icon: 'edit-undo-symbolic', run: () => {
        restoreLayout(settings, JSON.parse(settings.get_string('launcher-layout-undo')));
        settings.set_string('launcher-layout-undo', '');
    }});
    return result;
}

// Bounded, cancellable directory traversal. Never follow symlinks or inspect hidden trees.
// No synchronous file reads or external indexing service in the Shell search path.
export async function searchFiles(query, roots, cancellable, onProgress = null) {
    const expanded = query.replace(/^~(?=\/|$)/, GLib.get_home_dir());
    const isPath = expanded.startsWith('/');
    const needle = isPath ? expanded.endsWith('/') ? '' : GLib.path_get_basename(expanded) : query;
    const queue = (isPath ? [expanded.endsWith('/') ? expanded : GLib.path_get_dirname(expanded)] : roots.map(root => root.replace(/^~(?=\/|$)/, GLib.get_home_dir())))
        .filter(root => root.startsWith('/')).map(path => [Gio.File.new_for_path(path), 0]);
    const found = [], seen = new Set();
    let visited = 0, published = 0, lastPublish = 0;
    while (queue.length && visited < 15000 && !cancellable.is_cancelled()) {
        const [directory, depth] = queue.shift();
        const path = directory.get_path();
        if (seen.has(path)) continue;
        seen.add(path);
        let enumerator;
        try {
            enumerator = await new Promise((resolve, reject) => directory.enumerate_children_async('standard::name,standard::type,standard::is-symlink', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, GLib.PRIORITY_DEFAULT, cancellable, (file, res) => {
                try { resolve(file.enumerate_children_finish(res)); } catch (error) { reject(error); }
            }));
            while (!cancellable.is_cancelled() && visited < 15000) {
                const entries = await new Promise((resolve, reject) => enumerator.next_files_async(100, GLib.PRIORITY_DEFAULT, cancellable, (source, res) => {
                    try { resolve(source.next_files_finish(res)); } catch (error) { reject(error); }
                }));
                if (!entries.length) break;
                for (const info of entries) {
                    visited++;
                    const name = info.get_name();
                    if (name.startsWith('.')) continue;
                    const file = directory.get_child(name);
                    const folder = info.get_file_type() === Gio.FileType.DIRECTORY;
                    if (Number.isFinite(scoreItem(needle, {name}))) found.push({name, file, folder, detail: file.get_path()});
                    if (!isPath && folder && !info.get_is_symlink() && depth < 5 && !['node_modules', 'vendor'].includes(name)) queue.push([file, depth + 1]);
                }
                // Publish early hits while deeper folders are still being searched.
                const now = GLib.get_monotonic_time();
                if (onProgress && found.length !== published && now - lastPublish >= 100000 && !cancellable.is_cancelled()) {
                    onProgress(filterMatches(needle, found).slice(0, 60));
                    published = found.length; lastPublish = now;
                }
            }
        } catch (error) { if (cancellable.is_cancelled()) return []; }
        finally { if (enumerator) enumerator.close_async(GLib.PRIORITY_DEFAULT, null, (source, res) => { try { source.close_finish(res); } catch {} }); }
    }
    return filterMatches(needle, found).slice(0, 60);
}

export function commandArgv(text) {
    const [ok, argv] = GLib.shell_parse_argv(text);
    if (!ok || !argv.length || !GLib.find_program_in_path(argv[0])) throw new Error('Enter an installed program and its arguments');
    return argv;
}

export function runCommand(argv, terminal, onError = error => console.warn(`Bezel command: ${error.message}`)) {
    let command = argv;
    if (terminal) {
        if (GLib.find_program_in_path('xdg-terminal-exec')) command = ['xdg-terminal-exec', ...argv];
        else if (GLib.find_program_in_path('kgx')) command = ['kgx', '--', ...argv];
        else if (GLib.find_program_in_path('gnome-terminal')) command = ['gnome-terminal', '--', ...argv];
        else if (GLib.find_program_in_path('xterm')) command = ['xterm', '-e', ...argv];
        else throw new Error('No supported terminal found. Install xdg-terminal-exec or GNOME Console.');
    }
    const launcher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.STDOUT_SILENCE | (terminal ? Gio.SubprocessFlags.STDERR_PIPE : Gio.SubprocessFlags.STDERR_SILENCE)});
    launcher.set_environ(global.create_app_launch_context(global.get_current_time(), -1).get_environment());
    launcher.set_cwd(GLib.get_home_dir());
    const process = launcher.spawnv(command);
    if (terminal) process.communicate_utf8_async(null, null, (source, result) => {
        try {
            const [, , stderr] = source.communicate_utf8_finish(result);
            if (!source.get_successful()) onError(new Error(stderr?.trim().slice(0, 1000) || 'Terminal exited unsuccessfully'));
        } catch (error) { onError(error); }
    });
    else process.wait_check_async(null, (source, result) => { try { source.wait_check_finish(result); } catch (error) { onError(error); } });
    return process;
}
