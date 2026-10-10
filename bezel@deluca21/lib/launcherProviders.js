import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {createSearchScorer, compareSearchResults} from './search.js';
import {PRESETS, resolveTheme} from './theme.js';
import {readBars, applyPreset} from './config.js';
import {savedLayouts, restoreLayout, rememberLayout, layoutValues} from './profiles.js';

const MEDIA_NAME = /\.(jpe?g|png|webp|svg|gif|mp4|webm|mkv|mov)$/i;
const IMAGE_NAME = /\.(jpe?g|png|webp|svg|gif)$/i;

export function filePreview(info, file) {
    let thumb = null, type = '', size = 0, fallback = null;
    try { thumb = info.get_attribute_byte_string('thumbnail::path'); } catch { /* Attribute is optional. */ }
    try { type = info.get_content_type() || ''; } catch { /* Content type is optional. */ }
    try { size = info.get_size(); } catch { /* Size is optional. */ }
    try { fallback = info.get_icon(); } catch { /* Icon is optional. */ }
    const name = file?.get_basename?.() ?? '';
    const media = type.startsWith('image/') || type.startsWith('video/') || MEDIA_NAME.test(name);
    const image = thumb ? Gio.File.new_for_path(thumb)
        : (type.startsWith('image/') || IMAGE_NAME.test(name)) && size < 20000000 ? file : null;
    return {gicon: image ? new Gio.FileIcon({file: image}) : fallback, media};
}

export function bezelResults(bar) {
    const settings = bar._overlay._settings;
    const open = (page, barIndex = -1, tab = 'contents') => bar._overlay.openSettings({page, barIndex, tab});
    const result = [];
    const add = (name, keywords, page, barIndex = -1, tab) => result.push({name, keywords: `bezel settings options ${keywords}`,
        category: barIndex >= 0 ? `bar-${barIndex}` : 'settings', barIndex, detail: 'Open Bezel settings',
        icon: 'preferences-system-symbolic', run: () => open(page, barIndex, tab),
        alternate: () => bar._overlay.openPreferences(), alternateLabel: 'All Bezel settings'});
    for (const [name, words, page] of [
        ['Themes and colours', 'appearance palette custom', 'look'], ['Layouts and bars', 'presets saved layout', 'bar'],
        ['Screen border', 'frame width radius shadow dashboard notifications position', 'frame'],
        ['Launcher and shortcuts', 'search files folders web engine commands keyboard shortcut launcher width', 'shortcuts'],
        ['Liquid', 'experimental liquid motion grow drip pour glass blur frame dock panel tint', 'liquid'],
        ['Opening and motion', 'animation duration hover delay edge dashboard power', 'opening'],
        ['Desktop options', 'weather hide gnome panel overview dock notifications date time format', 'desktop'],
    ]) add(name, words, page);
    readBars(settings).forEach((item, index) => {
        const name = `${item.edge} ${item.kind} ${index + 1}`;
        result.push({name, collection: `bar-${index}`, category: 'settings', barIndex: index,
            keywords: `bezel bar ${item.edge} ${item.kind} appearance behaviour modules`,
            detail: 'Behaviour, modules, size, appearance and app icons', icon: 'view-grid-symbolic',
            primaryLabel: 'Browse', run: () => open('bar', index),
            alternate: () => open('bar', index), alternateLabel: 'Edit bar'});
        for (const [title, words, tab] of [
            ['Behaviour', 'autohide floating reserve space', 'contents'], ['Modules and groups', 'contents add remove reorder', 'contents'],
            ['Size and spacing', 'thickness length margin icon size rounding', 'size'], ['Appearance', 'colour opacity padding', 'appearance'],
            ['App icons', 'hover lift highlight click focused running indicator pins', 'apps'],
        ]) add(`${title} · ${name}`, words, 'bar', index, tab);
    });
    const currentTheme = settings.get_string('theme');
    for (const palette of [...PRESETS, {...resolveTheme({get_string: key => key === 'theme' ? 'wallpaper' : settings.get_string(key)}), id: 'wallpaper', name: 'Wallpaper'}]) result.push({name: palette.name, category: 'themes', swatch: palette, keywords: 'bezel theme palette colours appearance',
        detail: currentTheme === palette.id ? 'Current theme' : 'Apply theme', selected: currentTheme === palette.id,
        icon: 'applications-graphics-symbolic', run: () => settings.set_string('theme', palette.id), alternate: () => open('look'), alternateLabel: 'Edit colours'});
    const apply = callback => {
        const previous = {name: 'Before launcher layout change', values: layoutValues(settings)};
        settings.set_string('launcher-layout-undo', JSON.stringify(previous));
        callback();
        rememberLayout(settings);
    };
    for (const [id, name] of [['caelestia', 'Bezel'], ['panel', 'Panel'], ['dock', 'Dock'], ['hybrid', 'Top + dock'], ['islands', 'Islands'], ['split', 'Split']])
        result.push({name: `${name} layout`, category: 'layouts', keywords: 'bezel layout preset', detail: 'Apply layout · previous setup available through Undo layout', icon: 'view-grid-symbolic', run: () => apply(() => applyPreset(settings, id)), alternate: () => open('bar'), alternateLabel: 'Edit bars'});
    for (const profile of savedLayouts(settings)) result.push({name: profile.name, category: 'layouts', keywords: 'bezel saved layout', detail: 'Load saved layout · restores its settings', icon: 'document-open-symbolic', run: () => apply(() => restoreLayout(settings, profile)), alternate: () => open('bar'), alternateLabel: 'Edit bars'});
    if (settings.get_string('launcher-layout-undo')) result.push({name: 'Undo layout change', category: 'layouts', keywords: 'bezel restore previous layout', detail: 'Restore setup before the last launcher layout change', icon: 'edit-undo-symbolic', run: () => {
        restoreLayout(settings, JSON.parse(settings.get_string('launcher-layout-undo')));
        settings.set_string('launcher-layout-undo', '');
    }});
    return result;
}

// Category actions open a focused picker; specific names remain searchable directly.
export function bezelSearchResults(bar, text, collection = null) {
    const items = bezelResults(bar);
    const open = page => bar._overlay.openSettings({page});
    const groups = [
        {name: 'Themes', collection: 'themes', keywords: 'bezel theme scheme colour color palette appearance',
            detail: 'Choose a colour theme', icon: 'applications-graphics-symbolic',
            alternateLabel: 'Edit colours', alternate: () => open('look')},
        {name: 'Layouts', collection: 'layouts', keywords: 'bezel layout presets saved bars dock panel',
            detail: 'Choose a preset or saved layout', icon: 'view-grid-symbolic',
            alternateLabel: 'Edit bars', alternate: () => open('bar')},
        {name: 'Bezel settings', collection: 'settings', keywords: 'bezel settings preferences options customize',
            detail: 'Browse settings by section', icon: 'preferences-system-symbolic',
            alternateLabel: 'Open settings', alternate: () => open('look')},
    ];
    if (collection) {
        if (/^bar-\d+$/.test(collection))
            return items.filter(item => item.category === collection);
        return [...(collection === 'settings' ? groups.slice(0, 2) : []), ...items.filter(item => item.category === collection)];
    }
    const general = /^(bezel|settings?|preferences?|options?|themes?|schemes?|colou?rs?|palettes?|appearance|layouts?|presets?)$/i.test(text.trim());
    const scoreName = createSearchScorer(text);
    return [...groups, ...items.filter(item => text.trim() && !general && (item.category === 'settings'
        || Number.isFinite(scoreName(item))))];
}

// Bounded, cancellable directory traversal. Never follow symlinks or inspect hidden trees.
// No synchronous file reads or external indexing service in the Shell search path.
export async function searchFiles(query, roots, cancellable, onProgress = null) {
    const expanded = query.replace(/^~(?=\/|$)/, GLib.get_home_dir());
    const isPath = expanded.startsWith('/');
    const needle = isPath ? expanded.endsWith('/') ? '' : GLib.path_get_basename(expanded) : query;
    const queue = (isPath ? [expanded.endsWith('/') ? expanded : GLib.path_get_dirname(expanded)] : roots.map(root => root.replace(/^~(?=\/|$)/, GLib.get_home_dir())))
        .filter(root => root.startsWith('/')).map(path => [Gio.File.new_for_path(path), 0]);
    const found = [], seen = new Set(), score = createSearchScorer(needle);
    let visited = 0, revision = 0, published = 0, lastPublish = 0, head = 0;
    while (head < queue.length && visited < 15000 && !cancellable.is_cancelled()) {
        const [directory, depth] = queue[head];
        queue[head++] = null;
        const path = directory.get_path();
        if (seen.has(path)) continue;
        seen.add(path);
        let enumerator;
        try {
            enumerator = await new Promise((resolve, reject) => directory.enumerate_children_async('standard::name,standard::type,standard::is-symlink,standard::icon,standard::content-type,standard::size,thumbnail::path', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, GLib.PRIORITY_DEFAULT, cancellable, (file, res) => {
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
                    const item = {name, file, folder, detail: file.get_path(), ...filePreview(info, file)};
                    item.score = score(item);
                    // Keep only the best visible results, with stable tie-breaking.
                    if (Number.isFinite(item.score) && (found.length < 60 || compareSearchResults(item, found[found.length - 1]) < 0)) {
                        let low = 0, high = found.length;
                        while (low < high) {
                            const middle = (low + high) >> 1;
                            if (compareSearchResults(item, found[middle]) < 0) high = middle;
                            else low = middle + 1;
                        }
                        found.splice(low, 0, item);
                        if (found.length > 60) found.pop();
                        revision++;
                    }
                    if (!isPath && folder && !info.get_is_symlink() && depth < 5 && !['node_modules', 'vendor'].includes(name)) queue.push([file, depth + 1]);
                }
                // Publish early hits while deeper folders are still being searched.
                const now = GLib.get_monotonic_time();
                if (onProgress && revision !== published && now - lastPublish >= 100000 && !cancellable.is_cancelled()) {
                    onProgress(found.slice());
                    published = revision; lastPublish = now;
                }
            }
        } catch (error) { if (cancellable.is_cancelled()) return []; }
        finally { if (enumerator) enumerator.close_async(GLib.PRIORITY_DEFAULT, null, (source, res) => { try { source.close_finish(res); } catch {} }); }
    }
    return cancellable.is_cancelled() ? [] : found;
}

export function commandArgv(text) {
    if (!String(text ?? '').trim())
        throw new Error('Enter an installed program and its arguments');
    let ok, argv;
    try {
        [ok, argv] = GLib.shell_parse_argv(text);
    } catch {
        throw new Error('Enter an installed program and its arguments');
    }
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
