// Run: gjs -m tests/launcher-settings-regressions.js
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Search from '../bezel@deluca21/lib/search.js';
import {searchFiles} from '../bezel@deluca21/lib/launcherProviders.js';
import * as geometry from '../bezel@deluca21/lib/geometry.js';
import {moveGroupCell, normalizeGroupLayout} from '../bezel@deluca21/lib/groupLayout.js';

const assert = (condition, message) => { if (!condition) throw new Error(message); };
const base = Gio.File.new_for_uri(import.meta.url).get_parent().get_parent().get_child('bezel@deluca21/lib');
const read = name => new TextDecoder().decode(base.get_child(name).load_contents(null)[1]);
const load = (name, bindings, exports) => new Function(...Object.keys(bindings),
    read(name).replace(/^import[\s\S]*?;\n/gm, '').replace(/^export /gm, '') + `\nreturn {${exports}};`)(...Object.values(bindings));

for (const [query, name, expected] of [
    ['firefox', 'Firefox', 0], ['friefox', 'Firefox', 45], ['firefx', 'Firefox', 35],
    ['firefoxx', 'Firefox', 45], ['firxxx', 'Firefox', Infinity], ['cafe', 'Café', 0],
    ['vsc', 'Visual Studio Code', 8], ['studio code', 'Visual Studio Code', 13],
]) assert(Search.matchScore(query, name) === expected, `search scoring: ${query}`);
// Compare the linear typo predicate with the former edit-distance definition.
const {withinOneEdit} = load('search.js', {}, 'withinOneEdit');
const distance = (a, b) => {
    const rows = Array.from({length: a.length + 1}, (_, i) => Array.from({length: b.length + 1}, (_, j) => i ? (j ? 0 : i) : j));
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
        rows[i][j] = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + Number(a[i - 1] !== b[j - 1]));
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) rows[i][j] = Math.min(rows[i][j], rows[i - 2][j - 2] + 1);
    }
    return rows[a.length][b.length];
};
const strings = ['', 'a', 'b'];
for (let length = 2; length <= 5; length++) for (let n = 0; n < 2 ** length; n++) strings.push(n.toString(2).padStart(length, '0').replaceAll('0', 'a').replaceAll('1', 'b'));
for (const a of strings) for (const b of strings) assert(withinOneEdit(a, b) === (distance(a, b) <= 1), `typo equivalence ${a}/${b}`);
assert(Number.isFinite(Search.matchScore('a'.repeat(50000) + 'c', 'a'.repeat(50000) + 'b')), 'long typo query remains matchable');

let serial = 0;
class Actor {
    constructor(props = {}) { this.children = []; this.signals = new Map(); this.clutter_text = this; Object.assign(this, props); if (props.child) this.children.push(props.child); }
    add_child(actor) { this.children.push(actor); }
    connect(name, fn) { const id = ++serial; this.signals.set(id, [name, fn]); return id; }
    disconnect(id) { assert(this.signals.delete(id), 'disconnect live signal'); }
    emit(name, ...args) { for (const [event, fn] of this.signals.values()) if (event === name) fn(this, ...args); }
    destroy_all_children() { this.children = []; }
    set_primary_icon() {}
    set_child(actor) { this.children = [actor]; }
    contains(actor) { return this.children.includes(actor) || this.children.some(child => child.contains?.(actor)); }
    get_stage() { return null; }
    get_text() { return this.text ?? ''; }
    set_text(value) { this.text = value; this.emit('text-changed'); }
    grab_key_focus() {}
}
let catalogReads = 0, iconCreates = 0, activation = null, fits = 0;
const apps = Array.from({length: 45}, (_, i) => ({
    get_id: () => `app-${i}.desktop`, get_name: () => `App ${String(i).padStart(2, '0')}`,
    get_app_info: () => ({should_show: () => true, get_keywords: () => []}),
    create_icon_texture: () => { iconCreates++; return new Actor(); },
}));
const system = new Actor();
system.get_installed = () => { catalogReads++; return apps; };
system.lookup_app = id => apps.find(app => app.get_id() === id);
system.get_running = () => [];
const settings = {get_string: () => 'ddg', get_boolean: () => false};
const bar = {_theme: {fg: '#fff', muted: '#aaa', accent: '#acf', surface: '#333'}, _overlay: {_settings: settings}, _state: {pinned: []},
    _popupCleanups: [], _later() {}, _cancel() {}, _fitPopup() { fits++; }, _close() {},
};
const {buildLauncher} = load('launcher.js', {...Search,
    Shell: {AppSystem: {get_default: () => system}}, St: {BoxLayout: Actor, Label: Actor, Entry: Actor, Icon: Actor, Button: Actor},
    Clutter: {Orientation: {VERTICAL: 1}, ActorAlign: {FILL: 1}, KEY_Up: 1, KEY_Down: 2, ModifierType: {SHIFT_MASK: 1}},
    Pango: {EllipsizeMode: {END: 1}}, Gio, GLib, Main: {}, SystemActions: {getDefault: () => ({})},
    dndControl: () => null, darkStyleControl: () => null, nightLightControl: () => null, settingsPanels: () => [], bezelResults: () => [],
    appWindows: () => [], activateApp: app => { activation = app; }, commandArgv: () => { throw new Error('empty'); },
}, 'buildLauncher');
const launcher = buildLauncher(bar), entry = bar._launcherEntry;
assert(iconCreates === 20 && fits === 1, 'initial visible row budget');
const original = [...launcher.children[0].children];
for (let i = 0; i < 19; i++) bar._onPopupScroll(1);
assert(iconCreates === 20 && fits === 1, 'moving within visible results must reuse actors and avoid popup resizing');
assert(original.every((row, i) => row === launcher.children[0].children[i]), 'row actor identity retained');
entry.emit('activate'); assert(activation === apps[19], 'reused row selection activates correct app');
bar._onPopupScroll(1);
assert(iconCreates === 40 && launcher.children[0].children.length === 20, 'crossing viewport keeps bounded actor window');
entry.set_text('app'); entry.set_text('app 0');
assert(catalogReads === 1, 'app metadata cached while typing');
entry.set_text('/ document'); entry.set_text('$'); entry.set_text('? example');
assert(catalogReads === 1, 'special search modes do not enumerate apps');
system.emit('installed-changed'); assert(catalogReads === 1, 'catalog invalidation remains lazy in special mode');
entry.set_text(''); assert(catalogReads === 2, 'installed change refreshes cached applications');
for (const cleanup of bar._popupCleanups) cleanup();
assert(system.signals.size === 0 && bar._onPopupScroll === null, 'launcher cleanup disconnects external handlers');

const jobs = new Map();
const scheduler = {PRIORITY_DEFAULT_IDLE: 0, SOURCE_REMOVE: false,
    idle_add(_priority, callback) { const id = ++serial; jobs.set(id, callback); return id; }, source_remove(id) { jobs.delete(id); },
};
const advance = () => { const [id, callback] = jobs.entries().next().value; jobs.delete(id); callback(); };
const {SettingsWindow} = load('settings.js', {GLib: scheduler}, 'SettingsWindow');
const owner = Object.create(SettingsWindow.prototype);
const adjustment = new Actor({upper: 1000, page_size: 100, value: 0});
owner.editorScroll = {vadjustment: adjustment};
owner._holdScroll(100, false); advance(); owner._holdScroll(300, false);
assert(jobs.size === 1 && adjustment.signals.size === 1, 'replacement scroll hold cancels both phases of the prior restore');
while (jobs.size) advance();
assert(adjustment.value === 300 && adjustment.signals.size === 0, 'latest scroll restoration wins and releases its watcher');
owner._holdScroll(900, true); owner._closed = true; owner._cancelScrollHold();
assert(!jobs.size && !adjustment.signals.size, 'closing settings cancels scroll work');

const layout = normalizeGroupLayout({blocks: [{type: 'row', id: 'row', cells: [{id: 'a', module: 'clock'}, {id: 'b', module: 'date'}]}]});
assert(JSON.stringify(moveGroupCell(layout, 'a', 'row', 'a')) === JSON.stringify(layout), 'dropping a group cell onto itself preserves order');
assert(moveGroupCell(layout, 'a', 'row').blocks[0].cells[1].id === 'a', 'explicit move to row end still works');

// Controlled async directory reads exercise superseded requests and navigation.
const pendingReads = [], folderMonitors = [];
const makeFolder = path => ({
    get_path: () => path, get_basename: () => path.split('/').at(-1), get_parse_name: () => path,
    get_uri: () => `file://${path}`, equal: other => other.get_path() === path,
    get_parent: () => path === '/' ? null : makeFolder('/'), get_child: name => makeFolder(`${path}/${name}`),
    monitor_directory: () => { const monitor = new Actor(); monitor.cancel = () => { monitor.cancelled = true; }; folderMonitors.push(monitor); return monitor; },
    enumerate_children_async(_attributes, _flags, _priority, cancel, callback) { pendingReads.push({folder: this, cancel, callback}); },
    enumerate_children_finish: result => result,
});
const directoryInfo = name => ({get_name: () => name, get_display_name: () => name, get_file_type: () => Gio.FileType.REGULAR,
    get_attribute_byte_string: () => null, get_content_type: () => 'text/plain', get_size: () => 10, get_icon: () => null});
const finishRead = (request, names) => {
    let batch = names.map(directoryInfo);
    const iterator = {next_files_async(_size, _priority, _cancel, callback) { const result = batch; batch = []; callback(this, result); },
        next_files_finish: value => value, close_async() { this.closed = true; }};
    request.callback(request.folder, iterator); return iterator;
};
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const stage = new Actor();
let focus = null;
stage.get_key_focus = () => focus;
const folderBar = {...bar, _popout: null, _popupWidth: 400};
const folderClutter = {Orientation: {VERTICAL: 1, HORIZONTAL: 0}, ActorAlign: {FILL: 1, CENTER: 2, START: 0}, BinLayout: class {},
    EventType: {KEY_PRESS: 1}, ModifierType: {CONTROL_MASK: 1}, KEY_a: 65, KEY_A: 65};
const {liveFolder, fileFor} = load('shortcutRuntime.js', {...geometry,
    Gio: {Cancellable: Gio.Cancellable, File: {new_for_path: makeFolder}, FileType: Gio.FileType, FileQueryInfoFlags: Gio.FileQueryInfoFlags, FileMonitorFlags: Gio.FileMonitorFlags},
    GLib: {...scheduler, PRIORITY_DEFAULT: 0, get_home_dir: () => '/home/test'},
    Clutter: folderClutter, St: {BoxLayout: Actor, Label: Actor, ScrollView: Actor, Widget: Actor, Button: Actor, Icon: Actor, PolicyType: {NEVER: 0, AUTOMATIC: 1}},
    Pango: {EllipsizeMode: {END: 1, MIDDLE: 2}}, loadFileView: () => 'grid', global: {stage},
}, 'liveFolder,fileFor');
assert(fileFor('~').get_path() === '/home/test', 'bare tilde resolves to home');
const folderRoot = liveFolder(folderBar, '/fixture');
const toolbar = folderRoot.children[0];
assert(pendingReads.length === 1, 'initial directory read started');
toolbar.children[2].emit('clicked');
assert(pendingReads[0].cancel.is_cancelled() && !pendingReads[1].cancel.is_cancelled(), 'refresh cancels the superseded directory read');
const obsoleteIterator = finishRead(pendingReads[0], ['obsolete']);
const activeIterator = finishRead(pendingReads[1], ['first', 'second']);
await flush();
assert(obsoleteIterator.closed && activeIterator.closed, 'all completed directory enumerators close');
focus = folderRoot.children[1];
stage.emit('captured-event', {type: () => 1, get_key_symbol: () => 65, get_state: () => 1});
assert(folderRoot._selectedNames().join(',') === 'first,second', 'only current directory entries rendered');
const folderList = folderRoot.children[1].children[0].children[0];
assert(folderList.children.length > 0, 'directory rows visible before navigation');
toolbar.children[1].emit('clicked');
assert(folderList.children.length === 0 && folderRoot._selectedNames().length === 0, 'navigation immediately clears old entries and selection');
folderRoot.emit('destroy');
assert(pendingReads[2].cancel.is_cancelled() && stage.signals.size === 0, 'folder destruction cancels pending read and global handler');
assert(folderMonitors.every(monitor => monitor.cancelled), 'old and current directory monitors released');
finishRead(pendingReads[2], ['late']); await flush();
assert(folderList.children.length === 0, 'late directory result cannot repopulate a destroyed view');

const directory = GLib.dir_make_tmp('bezel-launcher-regression-XXXXXX');
const root = Gio.File.new_for_path(directory), created = [], expected = [];
try {
    for (let i = 240; i >= 0; i--) {
        const name = i === 0 ? 'match' : `match-${String(i).padStart(3, '0')}`;
        const file = root.get_child(name); file.replace_contents('fixture', null, false, Gio.FileCreateFlags.NONE, null); created.push(file);
        expected.push({name, file, folder: false, detail: file.get_path()});
    }
    const snapshots = [];
    const found = await searchFiles('match', [directory, directory], new Gio.Cancellable(), items => snapshots.push(items));
    const reference = Search.filterMatches('match', expected).slice(0, 60);
    assert(found.length === 60 && JSON.stringify(found.map(item => item.name)) === JSON.stringify(reference.map(item => item.name)), 'bounded file results equal complete ranking, with duplicate roots');
    assert(snapshots.every(items => items.length <= 60), 'partial file results remain bounded');
    const cancel = new Gio.Cancellable(); cancel.cancel();
    assert((await searchFiles('match', [directory], cancel)).length === 0, 'cancelled file search yields no stale rows');
} finally {
    for (const file of created) file.delete(null);
    root.delete(null);
}
print('PASS: launcher row reuse/cache, 3969 typo comparisons, bounded async file search, settings scroll lifecycle, group self-drop, live-folder refresh/navigation lifecycle');
