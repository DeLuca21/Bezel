import {LayoutTransition} from './layoutTransition.js';
import {activateApp, appClickHandler} from './appActivation.js';
import {AppIconGeometry} from './appIconGeometry.js';
import {moduleType, moduleView} from './moduleIdentity.js';
import {moduleFeatures} from './moduleFeatures.js';
import {expandedModule, inputDevices, outputDevices} from './expandedModules.js';
import {shortcutFace} from './shortcutRuntime.js';
import {shelfFace, shelfPanel, stopShelfHelper} from './shelf.js';
import {timerFace} from './timers.js';
import {buildGroupPopout} from './groupPopout.js';
import {GROUP_ITEMS, groupLayoutPreset} from './groupLayout.js';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Slider from 'resource:///org/gnome/shell/ui/slider.js';
import * as SystemActions from 'resource:///org/gnome/shell/misc/systemActions.js';

import {hexToRgba, resolveTheme} from './theme.js';

import {PLACES, DATE_FORMATS, timePattern, barDateFormat, barTimeFormat, readState, readBars, saveBars, clamp, settingFlag, settingChoice, isSpacer, barGroups, barTheme, groupFillColor, groupAppearance, hoverEnabled, moduleLook, sliderLayout, powerLayout, powerDim, switchOn, adoptIndicators, recordingStopHost, barShadowDepth} from './config.js';
import {sideWidths, reservedWidths, cornerRadius, zonePlacement} from './geometry.js';
import {paintCorner, paintPillBackdrop} from './drawing.js';
import {Services} from './services.js';
import {DesktopFrame} from './frame.js';
import {monthGrid, openCalendarDate} from './calendar.js';
import {Weather, weatherWidget, railTemp} from './weather.js';
import {buildMediaFace, buildMicFace, buildMicPanel, buildClipboardPanel, buildKeyboardFace, buildKeyboardPanel, buildAwakeFace, buildValueButton} from './extraModules.js';
import {buildDashboard} from './dashboard.js';
import {buildOsd, buildStacked, buildLevelControl, buildSessionRail} from './sidebar.js';
import {buildLauncher} from './launcher.js';
import {buildDeviceControls, buildDevicePanel, deviceAvailable} from './quickControls.js';
import {IndicatorBridge} from './indicators.js';
import {logoFile} from './logos.js';
import * as Config from 'resource:///org/gnome/shell/misc/config.js';
import {allowsMotion, chromeOptions} from './compat.js';
import {NotificationBridge, buildNotificationCenter} from './notifications.js';
import {decorateScroll} from './overflow.js';
import {MODULES, createGroup, deleteGroup, assignGroup, resizeSpacer, addBar, addModule, patchBar, patchModule, removeBar, removeModule, setFloating, setKind, nudgeUnit} from './settingsModel.js';
import {activateScreenshot, bindToggle, darkStyleControl, dndControl, moduleSection, nightLightControl, performanceMenu, screenshotFace, screenshotRecording, settingsMenu, vpnMenu, watchScreenshotRecording} from './tools.js';

export class BezelOverlay {
    constructor(settings, openPreferences) {
        this._openPreferences = openPreferences;
        this._settings = settings;
        this.settingsBar = null;
        this._editAdds = [];
        this._editEscape = 0;
        this.services = new Services();
        this.weather = new Weather();
        this._chrome = [];
        this._frames = new Map();
        this._bars = [];
        this.appIconGeometry = new AppIconGeometry();
        this._layoutTransition = new LayoutTransition(this);
        this._id = settings.connect('changed', (_settings, key) => {
            if (key === 'layout-transition-request') {
                this._animateLayout = true;
                this.queueRebuild();
                return;
            }
            if (['layout-transition', 'layout-transition-duration'].includes(key)) return;
            if (key === 'edit-mode')
                this._syncEditEscape();
            if (key === 'preferences-bar') {
                this.settingsBar = this._settings.get_int(key);
                for (const bar of this._bars) bar.syncEditOutline();
                return;
            }
            if (['preferences-group', 'preferences-target', 'launcher-layout-undo', 'launcher-files', 'launcher-file-roots', 'launcher-web-engine'].includes(key)) return;
            if (key === 'group-preview') {
                try { this._groupPreview = JSON.parse(settings.get_string(key)); } catch { this._groupPreview = null; }
                if (this._groupPreview?.action === 'open') this._showGroupPreview();
                else { this._groupPreview = null; this._bars.forEach(bar => { if (bar._popoutId?.startsWith('group:')) bar._close(); }); }
                return;
            }
            if (key === 'show-settings') {
                this.openSettings();
                return;
            }
            if (key === 'theme')
                this._animateLayout = true;
            if (!['known-indicators', 'saved-layouts', 'previous-layout', 'layout-baseline', 'shortcut-overrides', 'show-settings', 'preferences-bar'].includes(key)) this.queueRebuild();
        });
        this._monitors = Main.layoutManager.connect('monitors-changed', () => this.queueRebuild());
        this._recordingWatch = Main.screenshotUI?.connect('notify::screencast-in-progress', () => this._syncRecordingStop());
        this._overview = Main.overview.connect('showing', () => this._bars.forEach(bar => bar._close()));
        this._fullscreen = global.display.connect('in-fullscreen-changed', () => {
            for (const [index, frame] of this._frames)
                frame.actor.visible = !global.display.get_monitor_in_fullscreen(index);
            for (const bar of this._bars) {
                if (global.display.get_monitor_in_fullscreen(bar._monitor.index))
                    bar._close();
            }
            this._notifications?.restyle();
        });
        this._rebuildId = 0;
        try {
            this.rebuild();
        } catch (error) {
            this.destroy();
            throw error;
        }
    }

    queueRebuild() {
        if (this._holdRebuild)
            return;
        if (this._rebuildId)
            GLib.source_remove(this._rebuildId);
        this._rebuildId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 40, () => {
            this._rebuildId = 0;
            try {
                const animate = this._animateLayout;
                this._animateLayout = false;
                if (animate) this._layoutTransition.run(() => this.rebuild());
                else { this._layoutTransition.cancel(); this.rebuild(); }
            } catch (error) {
                console.error('Bezel rebuild failed', error);
                Main.panel.show();
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    skipRebuild(fn) {
        this._holdRebuild = true;
        if (this._rebuildId) {
            GLib.source_remove(this._rebuildId);
            this._rebuildId = 0;
        }
        try {
            fn();
        } finally {
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                if (this._rebuildId) {
                    GLib.source_remove(this._rebuildId);
                    this._rebuildId = 0;
                }
                this._holdRebuild = false;
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    rebuild() {
        this._clear();
        try {
            if (adoptIndicators(this._settings))
                this.skipRebuild(() => {});
            const theme = resolveTheme(this._settings);
            const state = readState(this._settings);
            for (const physicalMonitor of Main.layoutManager.monitors) {
                const topInset = !this._settings.get_boolean('hide-gnome-panel') && physicalMonitor.index === Main.layoutManager.primaryIndex
                    ? Main.layoutManager.panelBox.height : 0;
                const monitor = {...physicalMonitor, y: physicalMonitor.y + topInset, height: physicalMonitor.height - topInset};
                const side = sideWidths(state);
                if (state.border) {
                    const frame = new DesktopFrame(monitor, theme, side, state);
                    chrome(frame.actor, false, false);
                    frame.actor.visible = !global.display.get_monitor_in_fullscreen(monitor.index);
                    this._chrome.push(frame.actor);
                    this._frames.set(monitor.index, frame);
                }
                state.bars.forEach((barState, index) => {
                    const bar = new Bar(this, monitor, theme, {...state, ...barState}, side, index);
                    this._bars.push(bar);
                });
                if (state.edgePanels) this._edgeHotspot(monitor, theme, 'top', side);
                if (state.powerHover) this._edgeHotspot(monitor, theme, 'bottom', side);
                if (state.bars.some(bar => sliderLayout(bar.modules.find(item => item.id === 'volume'), this._settings) === 'edge'))
                    this._osdHotspot(monitor, theme, side);
                if (this._settings.get_boolean('frame-notifications')) {
                    const at = settingChoice(this._settings, 'notifications-position', 'top-right',
                        ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'top-center', 'bottom-center', 'icon']);
                    const loc = ['top-left', 'top-right', 'bottom-left', 'bottom-right'].includes(at) ? at : 'top-right';
                    this._edgeHotspot(monitor, theme, loc.startsWith('bottom') ? 'bottom' : 'top', side, true, loc);
                }
                if (monitor.index === Main.layoutManager.primaryIndex) {
                    const target = this._bars.find(bar => bar._monitor.index === monitor.index && bar._indicatorSlot);
                    if (target) this._indicators = new IndicatorBridge(target);
                }
                if (monitor.index === Main.layoutManager.primaryIndex && this._settings.get_boolean('frame-notifications')) {
                    const frame = this._frames.get(monitor.index);
                    this._notifications = new NotificationBridge(physicalMonitor, side, theme, state.border, state.radius, frame, this._settings);
                    if (frame) {
                        frame.onJoinChange = () => this._notifications?.restyle();
                        frame.onSidesChange = () => this._notifications?.position();
                    }
                }
                if (state.editMode)
                    this._addEdgeHandle(physicalMonitor, theme, state);
                const measuredState = {...state, bars: this._bars.filter(bar => bar._monitor.index === monitor.index)
                    .map(bar => ({...bar._state, thickness: bar._vertical ? bar._box.width : bar._box.height}))};
                const reserved = reservedWidths(measuredState);
                for (const [edge, width] of Object.entries(reserved)) {
                    if (width > 0)
                        this._chrome.push(strut(physicalMonitor, edge, width + (edge === 'top' ? topInset : 0)));
                }
            }
            this._syncEditEscape();
            this._syncRecordingStop();
            if (this._groupPreview?.action === 'open') this._showGroupPreview();
        } catch (error) {
            this._clear();
            throw error;
        }
    }

    _syncRecordingStop() {
        const primary = Main.layoutManager.primaryIndex ?? 0;
        const sample = this._bars.filter(bar => bar._monitor.index === primary).sort((a, b) => a._index - b._index);
        const host = screenshotRecording() ? recordingStopHost(sample.map(bar => bar._state)) : null;
        for (const bar of this._bars)
            bar.syncRecordingStop(Boolean(host) && bar._index === host.index && bar._monitor.index === primary, host?.place);
    }

    _showGroupPreview() {
        const request = this._groupPreview;
        const bar = this._bars.find(bar => bar._index === request?.bar && bar._monitor.index === Main.layoutManager.primaryIndex);
        const group = bar && barGroups(bar._state).find(group => group.id === request.group);
        if (!group?.popout) return;
        const anchor = bar._order.find(item => item.id === group.id)?.actor ?? bar._actor;
        bar._open(`group:${group.id}`, anchor, () => buildGroupPopout(bar, group), 'right');
    }

    openPreferences() {
        this.openSettings();
    }

    openSettings(options = {}) {
        try {
            this._settings.set_int('preferences-bar', Number.isInteger(options.barIndex) ? options.barIndex : -1);
            this._settings.set_string('preferences-group', options.groupId || '');
            this._settings.set_string('preferences-target', JSON.stringify({page: options.page || '', tab: options.tab || ''}));
            this._openPreferences?.()?.catch?.(error => console.error('Bezel preferences failed', error));
        } catch (error) {
            console.error('Bezel settings failed to open', error);
        }
    }

    _syncEditEscape() {
        const editing = this._settings?.get_boolean('edit-mode');
        if (editing && !this._editEscape) {
            this._editEscape = global.stage.connect('captured-event', (_stage, event) => {
                if (!this._settings?.get_boolean('edit-mode'))
                    return Clutter.EVENT_PROPAGATE;
                if (event.type() !== Clutter.EventType.KEY_PRESS || event.get_key_symbol() !== Clutter.KEY_Escape)
                    return Clutter.EVENT_PROPAGATE;
                this._settings.set_boolean('edit-mode', false);
                return Clutter.EVENT_STOP;
            });
        } else if (!editing && this._editEscape) {
            global.stage.disconnect(this._editEscape);
            this._editEscape = 0;
        }
    }

    _addEdgeHandle(monitor, theme, state) {
        const used = new Set(state.bars.map(bar => bar.edge));
        for (const edge of ['left', 'top', 'right', 'bottom']) {
            if (used.has(edge))
                continue;
            const button = new St.Button({
                label: '+',
                reactive: true,
                can_focus: true,
                width: 28,
                height: 28,
                accessible_name: `Add a bar on the ${edge}`,
                style: `background-color: ${theme.accent}; color: ${theme.bg}; border-radius: 14px; font-weight: bold;`,
            });
            button._bezelEdge = edge;
            const size = 28;
            if (edge === 'left')
                button.set_position(monitor.x + 10, monitor.y + Math.round(monitor.height / 2 - size / 2));
            else if (edge === 'right')
                button.set_position(monitor.x + monitor.width - size - 10, monitor.y + Math.round(monitor.height / 2 - size / 2));
            else if (edge === 'top')
                button.set_position(monitor.x + Math.round(monitor.width / 2 - size / 2), monitor.y + 10);
            else
                button.set_position(monitor.x + Math.round(monitor.width / 2 - size / 2), monitor.y + monitor.height - size - 10);
            button.connect('clicked', () => addBar(this._settings, edge));
            chrome(button, true, false);
            this._chrome.push(button);
            this._editAdds.push(button);
        }
    }

    toggleLauncher(preferredBar = null) {
        const open = this._bars.find(bar => bar._popoutId === 'launcher');
        if (open) { open._close(true); return; }
        if (Main.sessionMode.isLocked || Main.sessionMode.isGreeter) return;
        const monitor = global.display.get_current_monitor();
        const bar = preferredBar ?? this._bars.find(item => item._monitor.index === monitor) ?? this._bars[0];
        if (!bar) return;
        Main.overview.hide();
        for (const record of this._indicators?.records.values() ?? [])
            record.menu?.close();
        bar._open('launcher', bar._actor, () => buildLauncher(bar), 'bottom');
        bar._launcherEntry.grab_key_focus();
    }

    pin(desktopId, barIndex) {
        const state = readState(this._settings);
        const id = `app:${desktopId}`;
        const bar = state.bars[barIndex];
        if (bar.pinned.includes(id))
            return;
        bar.pinned.push(id);
        if (!bar.modules.some(item => item.id === 'apps'))
            bar.modules.push({id: 'apps', place: 'start'});
        saveBars(this._settings, state.bars);
    }

    unpin(id, barIndex) {
        const state = readState(this._settings);
        state.bars[barIndex].pinned = state.bars[barIndex].pinned.filter(item => item !== id);
        saveBars(this._settings, state.bars);
    }

    moveModule(barIndex, id, along, bar) {
        const state = readState(this._settings);
        const barState = state.bars[barIndex];
        if (!barState || !bar)
            return;
        const grouped = barState.modules.filter(item => item.group === id).map(item => item.id);
        const block = grouped.length ? grouped : id === 'status' ? ['volume', 'network', 'battery'] : [id];
        const [bx, by] = bar._actor.get_transformed_position();
        const [bw, bh] = bar._actor.get_transformed_size();
        const span = bar._vertical ? bh : bw;
        const origin = bar._vertical ? by : bx;
        const ratio = (along - origin) / Math.max(1, span);
        const place = ratio < 0.34 ? 'start' : ratio < 0.67 ? 'center' : 'end';
        const moving = new Set(block);
        const rest = barState.modules.filter(item => !moving.has(item.id));
        const moved = barState.modules.filter(item => moving.has(item.id)).map(item => ({...item, place}));
        let insertAt = rest.length;
        for (let i = 0; i < rest.length; i++) {
            const item = rest[i];
            const entry = bar._order.find(order => order.id === item.id || order.id === item.group);
            if (!entry?.actor)
                continue;
            const [ix, iy] = entry.actor.get_transformed_position();
            const [iw, ih] = entry.actor.get_transformed_size();
            if (along < (bar._vertical ? iy + ih / 2 : ix + iw / 2)) {
                insertAt = i;
                break;
            }
        }
        rest.splice(insertAt, 0, ...moved);
        barState.modules = rest;
        saveBars(this._settings, state.bars);
    }

    relayoutPopups(monitorIndex, refit = false) {
        for (const bar of this._bars) {
            if (bar._monitor.index !== monitorIndex || !bar._popout)
                continue;
            if (refit) {
                bar._popupGeometry = null;
                bar._fitPopup();
            } else {
                bar._placePopup();
            }
        }
        if (this._notifications?.monitor?.index === monitorIndex)
            this._notifications.position();
    }

    destroy() {
        this._layoutTransition.cancel();
        if (this._rebuildId)
            GLib.source_remove(this._rebuildId);
        if (this._id)
            this._settings.disconnect(this._id);
        if (this._monitors)
            Main.layoutManager.disconnect(this._monitors);
        if (this._overview)
            Main.overview.disconnect(this._overview);
        if (this._fullscreen)
            global.display.disconnect(this._fullscreen);
        if (this._editEscape) {
            global.stage.disconnect(this._editEscape);
            this._editEscape = 0;
        }
        if (this._recordingWatch)
            Main.screenshotUI?.disconnect(this._recordingWatch);
        this._recordingWatch = 0;
        this._clear();
        this.appIconGeometry.destroy();
        stopShelfHelper();
        this.services.destroy();
        this.weather.destroy();
        this._settings = null;
    }

    _edgeHotspot(monitor, _theme, edge, side, notifications = false, location = null) {
        // A small centered target avoids stealing titlebar clicks along the entire edge.
        const occupied = this._bars.find(bar => bar._monitor === monitor && bar._state.edge === edge);
        const band = occupied ? 3 : Math.max(3, edge === 'top' ? side.top : side.bottom);
        const span = Math.min(180, monitor.width - side.left - side.right);
        const spot = new St.Widget({reactive: true, track_hover: true});
        const loc = location ?? (notifications ? 'top-right' : `${edge}-center`);
        let x = monitor.x + side.left + (monitor.width - side.left - side.right - span) / 2;
        if (loc.endsWith('-right'))
            x = monitor.x + monitor.width - side.right - span;
        if (loc.endsWith('-left'))
            x = monitor.x + side.left;
        spot.set_position(x, edge === 'top' ? monitor.y : monitor.y + monitor.height - band);
        spot.set_size(span, band);
        let timer = 0;
        const cancel = () => {
            if (timer)
                GLib.source_remove(timer);
            timer = 0;
        };
        spot.connect('notify::hover', () => {
            cancel();
            if (occupied) occupied._edgeHoverActive = spot.hover;
            const bar = occupied ?? this._bars.find(item => item._monitor === monitor);
            if (!bar)
                return;
            if (!spot.hover) {
                bar._closeSoon();
                if (occupied?._state.autohide) occupied._slideLater();
                return;
            }
            if (this._bars.some(item => item !== bar && item._containsPointer?.()))
                return;
            if (occupied?._state.autohide) occupied._slide(true, true);
            timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._settings.get_int('hover-delay') + (occupied ? 350 : 0), () => {
                timer = 0;
                if (spot.hover && !Main.overview.visible && !this._bars.some(item => item !== bar && item._containsPointer?.()))
                    bar._open(notifications ? 'notifications' : edge === 'top' ? 'dashboard' : 'power', spot,
                        () => notifications ? buildNotificationCenter(bar) : edge === 'top' ? bar._dashboard() : bar._session(), edge, true);
                return GLib.SOURCE_REMOVE;
            });
        });
        spot.connect('destroy', cancel);
        chrome(spot, true);
        this._chrome.push(spot);
    }

    _osdHotspot(monitor, theme, side) {
        const band = 10;
        const height = Math.min(280, Math.max(160, monitor.height / 3));
        const spot = new St.Widget({reactive: true, track_hover: true, style: 'background-color: transparent;'});
        spot.set_position(monitor.x + monitor.width - side.right - band,
            monitor.y + (monitor.height - height) / 2);
        spot.set_size(band + side.right, height);
        let timer = 0;
        const cancel = () => { if (timer) GLib.source_remove(timer); timer = 0; };
        spot.connect('notify::hover', () => {
            cancel();
            const bar = this._bars.find(item => item._monitor.index === monitor.index) ?? this._bars[0];
            if (!bar)
                return;
            if (!spot.hover) {
                bar._closeSoon();
                return;
            }
            timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._settings.get_int('hover-delay'), () => {
                timer = 0;
                if (spot.hover && !Main.overview.visible)
                    bar._open('osd', spot, () => buildOsd(bar), 'right', true);
                return GLib.SOURCE_REMOVE;
            });
        });
        spot.connect('destroy', cancel);
        chrome(spot, true);
        this._chrome.push(spot);
        void theme;
    }

    _showDim(monitor, opening) {
        this._hideDim();
        const dim = new St.Widget({
            reactive: true, track_hover: true,
            style: 'background-color: rgba(0,0,0,0.22);',
        });
        dim.set_position(monitor.x, monitor.y);
        dim.set_size(monitor.width, monitor.height);
        dim.connect('button-press-event', () => {
            this._bars.find(bar => bar._popout)?._close(true);
            return Clutter.EVENT_STOP;
        });
        chrome(dim, true, false);
        // Dim the desktop beneath Bezel, including beneath antialiased corners.
        // An inset rectangle above the frame also darkens its curved shoulders.
        const parent = dim.get_parent();
        const firstChrome = parent.get_children().find(actor => actor !== dim &&
            (this._chrome.includes(actor) || this._bars.some(bar => bar._actor === actor)));
        if (firstChrome)
            parent.set_child_below_sibling(dim, firstChrome);
        this._dim = dim;
        this._chrome.push(dim);
    }

    _hideDim() {
        const dim = this._dim;
        this._dim = null;
        if (!dim)
            return;
        this._chrome = this._chrome.filter(actor => actor !== dim);
        drop(dim);
    }

    _clear() {
        this._editAdds = [];
        this._notifications?.destroy();
        this._notifications = null;
        this._indicators?.destroy();
        this._indicators = null;
        for (const bar of this._bars)
            bar.destroy();
        this._bars = [];
        this._hideDim();
        for (const actor of this._chrome)
            drop(actor);
        this._chrome = [];
        this._frames.clear();
    }
}

class Bar {
    constructor(overlay, monitor, theme, state, side, index) {
        this._overlay = overlay;
        this._monitor = monitor;
        this._theme = barTheme(theme, state, state.border);
        this._state = state;
        this._side = side;
        this._index = index;
        this._popout = null;
        this._signals = [];
        this._timers = new Set();
        this._cleanups = [];
        this._order = [];
        this._vertical = state.edge === 'left' || state.edge === 'right';
        try {
            this._build();
        } catch (error) {
            this.destroy();
            throw error;
        }
    }

    destroy() {
        this._destroyed = true;
        this._revealTimeline?.stop();
        this._revealTimeline = null;
        const actor = this._actor;
        this._actor = null;
        this._endGeom(false);
        if (this._appsHandleLater)
            global.compositor.get_laters().remove(this._appsHandleLater);
        this._appsHandleLater = 0;
        if (this._appsOffsetLater)
            global.compositor.get_laters().remove(this._appsOffsetLater);
        this._appsOffsetLater = 0;
        this._close();
        this._endDrag();
        this._revealTimeline?.stop();
        for (const cleanup of this._cleanups)
            cleanup();
        for (const id of this._timers)
            GLib.source_remove(id);
        this._timers.clear();
        for (const [obj, id] of this._signals)
            obj.disconnect(id);
        for (const handle of Object.values(this._editHandles ?? {}))
            drop(handle);
        this._editHandles = null;
        drop(actor);
        drop(this._trigger);
    }

    _build() {
        const vertical = this._vertical;
        this._attachedToFrame = this._state.border && this._state.kind !== 'dock' && !this._state.margin && this._state.length === 100;
        this._joinedAutohide = this._attachedToFrame && this._state.autohide;
        const pills = this._state.sections === 'pills';
        const pad = this._barPadding();
        const padding = vertical ? `${pad.along}px ${pad.cross}px` : `${pad.cross}px ${pad.along}px`;
        this._actor = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            reactive: true,
            track_hover: true,
            clip_to_allocation: false,
            style: 'background-color: transparent;',
        });
        this._content = new St.BoxLayout({
            orientation: vertical ? Clutter.Orientation.VERTICAL : Clutter.Orientation.HORIZONTAL,
            x_expand: true, y_expand: true,
            clip_to_allocation: false,
            style: `spacing: ${pills ? 0 : 8}px; padding: ${padding};`,
        });
        // Paint outside the bar's allocation without enlarging its input or
        // reserved region. CSS shadows change blur paths for wider radii and
        // can abruptly lose strength on thin panels. Attached in-frame bars
        // use the screen border fill instead of a second plate.
        if (!pills && !this._attachedToFrame) {
            this._backdrop = this._backdropPlate(area => this._paintBarBackdrop(area));
            this._actor.add_child(this._backdrop);
        }
        this._actor.add_child(this._content);
        this._baseStyle = this._actor.style;
        this.syncEditOutline();
        const icon = Math.min(this._state.iconSize, this._state.thickness - 12);
        const zones = {
            start: this._zone(),
            center: this._zone(),
            end: this._zone(),
        };
        const seenGroups = new Set();
        for (const item of this._state.modules) {
            let actor;
            let dragId = item.id;
            if (item.group) {
                if (seenGroups.has(item.group))
                    continue;
                seenGroups.add(item.group);
                const members = this._state.modules.filter(module => module.group === item.group);
                actor = this._cluster(members, icon);
                dragId = item.group;
                const group = barGroups(this._state).find(entry => entry.id === item.group);
                const fill = groupFillColor(group, this._state, this._theme);
                if (actor) {
                    // The padding is always there, so the colour only fills it.
                    // Turning the colour on does not change the group's size.
                    const appearance = groupAppearance(group, this._state);
                    const along = appearance.padding;
                    const cross = appearance.inset;
                    const pad = new St.BoxLayout({
                        orientation: this._content.orientation,
                        x_expand: false, y_expand: false,
                        style: `padding: ${this._vertical ? `${along}px ${cross}px` : `${cross}px ${along}px`};`,
                    });
                    pad._bezelGroupPadding = true;
                    pad.add_child(actor);
                    const background = new St.Widget({
                        x_expand: true, y_expand: true,
                        style: fill ? `background-color: ${hexToRgba(fill, appearance.opacity / 100)}; border-radius: ${appearance.rounding}px;` : '',
                    });
                    const shell = new St.Widget({
                        layout_manager: new Clutter.BinLayout(),
                        clip_to_allocation: false,
                        x_expand: false, y_expand: false,
                    });
                    shell.add_child(background);
                    shell.add_child(pad);
                    shell._bezelPack = pad;
                    actor = shell;
                }
            } else {
                actor = this._module(item.id, icon);
            }
            if (!actor)
                continue;
            const place = item.place || PLACES[item.id] || 'end';
            zones[place].add_child(actor);
            this._order.push({id: dragId, actor});
            this._wire(actor);
            if (this._state.editMode)
                this._drag(actor, dragId);
        }
        this._emptyPills = new Set();
        if (pills) {
            for (const [place, zone] of Object.entries(zones)) {
                if (zone.get_n_children() === 0)
                    this._emptyPills.add(place);
            }
        }
        this._zoneAdds = [];
        if (this._state.editMode) {
            for (const place of ['start', 'center', 'end']) {
                const plus = this._zonePlus(place);
                zones[place].add_child(plus);
                this._zoneAdds.push(plus);
            }
        }
        if (pills) {
            for (const place of ['start', 'center', 'end']) {
                if (this._emptyPills.has(place) && !this._state.editMode) {
                    zones[place].visible = false;
                    continue;
                }
                zones[place]._bezelAlongPad = 20;
            }
        }
        this._zones = zones;
        // Vertical rails use equal cells; horizontal panels share unused space
        // so a long app list is not confined to an otherwise empty third.
        this._content.layout_manager.homogeneous = false;
        this._cells = [];
        this._appViewport = null;
        if (this._state.kind === 'dock') {
            this._dockContent = new St.BoxLayout({orientation: this._content.orientation,
                x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER,
                x_expand: true, y_expand: true, clip_to_allocation: true, style: 'spacing: 12px;'});
            this._dockViewport = this._appsClip();
            this._dockCell = new St.Widget({layout_manager: new Clutter.BinLayout(),
                x_expand: true, y_expand: true});
            this._dockCell.add_child(this._dockContent);
            this._content.add_child(this._dockCell);
        }
        for (const [place, zone] of Object.entries(zones)) {
            if (this._state.kind === 'dock') {
                this._attachZone(zone, place, this._dockContent);
                continue;
            }
            this._cells.push(this._attachZone(zone, place));
        }
        if (this._state.kind !== 'dock') {
            for (const cell of this._cells)
                if (cell)
                    this._content.add_child(cell);
            if (this._cells.filter(Boolean).length === 3) {
                const gap = () => {
                    const widget = new St.Widget({x_expand: false, y_expand: false, visible: false});
                    widget._bezelBalance = true;
                    return widget;
                };
                const before = gap();
                const after = gap();
                const centerAt = this._content.get_children().indexOf(this._cells[1]);
                this._content.insert_child_at_index(before, Math.max(0, centerAt));
                this._content.insert_child_at_index(after, Math.max(0, centerAt) + 2);
                this._zoneGaps = [before, after];
                this._content.spacing = 0;
                this._content.style = this._content.style.replace(/spacing:\s*\d+(?:\.\d+)?px/, 'spacing: 0px');
            }
        }
        if (this._state.kind === 'dock' && !this._dockViewport.get_parent())
            this._dockContent.add_child(this._dockViewport);
        chrome(this._actor, true);
        this._actor.connect('destroy', () => {
            this._revealTimeline?.stop();
            this._revealTimeline = null;
            this._actor = null;
        });
        this._place();
        this._ensureEditHandles();
        this._signals.push([this._actor, this._actor.connect('captured-event', (_actor, event) => this._barClick(event))]);
        this._signals.push([this._actor, this._actor.connect('captured-event', (_actor, event) => this._barScroll(event))]);
        if (this._state.autohide)
            this._enableAutohide();
    }

    syncEditOutline() {
        if (!this._actor || !this._baseStyle)
            return;
        const selected = this._state.editMode && this._overlay.settingsBar === this._index;
        const quiet = this._state.editMode && !selected;
        const color = selected ? this._theme.accent : this._theme.muted;
        this._actor.style = `${this._baseStyle}${quiet || selected ? ` border: 2px solid ${color};` : ''}`;
    }

    _zonePlus(place) {
        const button = new St.Button({
            label: '+',
            reactive: true,
            can_focus: true,
            accessible_name: `Add to ${place}`,
            style: `color: ${this._theme.accent}; background-color: ${this._theme.surface}; border-radius: 99px; padding: 0 7px; font-weight: bold;`,
        });
        button.connect('clicked', () => this._toggle(`add-${place}`, button, () => this._addMenu(place)));
        return button;
    }

    _barClick(event) {
        if (this._destroyed || event.type() !== Clutter.EventType.BUTTON_PRESS || event.get_button() !== 3)
            return Clutter.EVENT_PROPAGATE;
        const [x, y] = event.get_coords();
        const picked = event.get_source();
        // App menus also work when apps belong to a custom module group.
        for (let actor = picked; actor && actor !== this._actor; actor = actor.get_parent?.()) {
            if (actor._bezelAppId)
                return Clutter.EVENT_PROPAGATE;
        }
        if (this._appViewport && inside(this._appViewport, x, y)) {
            this._toggle('bar-menu', this._actor, () => this._barMenu());
            return Clutter.EVENT_STOP;
        }
        let module = this._order.find(item => {
            const actor = item.actor;
            if (!actor)
                return false;
            if (picked && (actor === picked || actor.contains(picked)))
                return true;
            return inside(actor, x, y);
        });
        if (module?.id === 'apps') {
            const icons = module.actor?.get_children?.() ?? [];
            const onIcon = icons.some(icon => icon === picked || icon.contains?.(picked));
            if (onIcon)
                return Clutter.EVENT_PROPAGATE;
            module = null;
        }
        if (module && (this._state.editMode || barGroups(this._state).some(group => group.id === module.id)))
            this._toggle(`module-${module.id}`, module.actor, () => this._moduleSettingsMenu(module.id));
        else
            this._toggle('bar-menu', this._actor, () => this._barMenu());
        return Clutter.EVENT_STOP;
    }

    // The icons are the pick target, so the wheel has to be caught on the bar
    // and the row slid by translation. A layout pass puts a plain position back.
    _barScroll(event) {
        if (this._destroyed || event.type() !== Clutter.EventType.SCROLL)
            return Clutter.EVENT_PROPAGATE;
        const view = this._appViewport;
        if (!view)
            return Clutter.EVENT_PROPAGATE;
        const [x, y] = event.get_coords();
        if (!inside(view, x, y))
            return Clutter.EVENT_PROPAGATE;
        if (!this._scrollAppsBy(scrollStep(event)))
            return Clutter.EVENT_PROPAGATE;
        this._cancel('_appHover');
        return Clutter.EVENT_STOP;
    }

    _barMenu() {
        const settings = this._overlay._settings;
        const bar = readBars(settings)[this._index];
        const editing = this._state.editMode;
        const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style: 'spacing: 8px;'});
        box.add_child(this._action('Settings', 'preferences-system-symbolic', () => {
            this._overlay.openSettings({barIndex: this._index, mode: 'bar', beside: true});
        }));
        box.add_child(this._action(editing ? 'Done' : 'Edit bars', editing ? 'object-select-symbolic' : 'document-edit-symbolic', () => {
            settings.set_boolean('edit-mode', !editing);
        }));
        box.add_child(this._action(bar.kind === 'dock' ? 'Use as panel' : 'Use as dock', 'view-list-symbolic', () => {
            setKind(settings, this._index, bar.kind === 'dock' ? 'panel' : 'dock');
        }));
        box.add_child(this._action(bar.margin > 0 ? 'Attach to the edge' : 'Float', 'view-fullscreen-symbolic', () => {
            setFloating(settings, this._index, !(bar.margin > 0));
        }));
        box.add_child(this._action(bar.autohide ? 'Keep visible' : 'Hide until the pointer hits the edge', 'view-conceal-symbolic', () => {
            patchBar(settings, this._index, {autohide: !bar.autohide});
        }));
        if (readBars(settings).length > 1)
            box.add_child(this._action('Remove bar', 'user-trash-symbolic', () => removeBar(settings, this._index)));
        return box;
    }

    _moduleSettingsMenu(id) {
        const settings = this._overlay._settings;
        const members = this._state.modules.filter(item => item.id === id || item.group === id);
        const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style: 'spacing: 8px;'});
        if (members.some(item => item.id === 'logo') || id === 'logo') {
            for (const [action, title] of [['launcher', 'Bezel launcher'], ['overview', 'GNOME Overview'], ['apps', 'App grid']])
                box.add_child(this._action(title, 'start-here-symbolic', () => patchBar(settings, this._index, {logoAction: action})));
        }
        if (members.some(item => item.id === 'date') || id === 'date') {
            const current = barDateFormat(readBars(settings)[this._index], settings);
            for (const [key, item] of Object.entries(DATE_FORMATS))
                box.add_child(this._action(key === current ? `${item.label} · on` : item.label, 'x-office-calendar-symbolic', () => patchBar(settings, this._index, {dateFormat: key})));
        }
        if (members.some(item => item.id === 'clock') || id === 'clock')
            this._timeActions(box, readBars(settings)[this._index]);
        if (id === 'dashboard' || members.some(item => item.id === 'dashboard'))
            this._dashboardClockActions(box);
        if (members.some(item => item.id === 'battery') || id === 'battery') {
            const current = readBars(settings)[this._index];
            const module = current.modules.find(item => item.id === 'battery');
            const shown = switchOn(module, current, 'showValue');
            box.add_child(this._action(shown ? 'Hide battery percentage' : 'Show battery percentage', 'battery-symbolic', () => {
                patchModule(settings, this._index, 'battery', {showValue: !shown});
            }));
        }
        const group = barGroups(readBars(settings)[this._index]).find(item => item.id === id);
        if (group) {
            box.add_child(this._action('Edit group popout…', 'document-edit-symbolic', () =>
                this._overlay.openSettings({barIndex: this._index, groupId: group.id})));
            box.add_child(this._action('Ungroup · keep contents', 'edit-clear-symbolic', () => deleteGroup(settings, this._index, id)));
            for (const member of members) {
                box.add_child(this._action(`Remove ${isSpacer(member.id) ? 'empty space' : member.id} from group`, 'list-remove-symbolic', () => assignGroup(settings, this._index, member.id, '')));
                if (isSpacer(member.id)) this._spacerMenu(box, member);
            }
            for (const item of readBars(settings)[this._index].modules.filter(item => item.group !== id))
                box.add_child(this._action(`Add ${isSpacer(item.id) ? 'empty space' : item.id} to group`, 'list-add-symbolic', () => assignGroup(settings, this._index, item.id, id)));
            box.add_child(this._action('Add empty space to group', 'list-add-symbolic', () => {
                const before = new Set(readBars(settings)[this._index].modules.map(item => item.id));
                addModule(settings, this._index, 'spacer', members[0]?.place ?? 'center');
                const added = readBars(settings)[this._index].modules.find(item => !before.has(item.id));
                if (added) assignGroup(settings, this._index, added.id, id);
            }));
        } else {
            if (isSpacer(id)) this._spacerMenu(box, members[0]);
            box.add_child(this._action('Create group with this item', 'list-add-symbolic', () => createGroup(settings, this._index, 'New group', [id])));
            for (const candidate of barGroups(readBars(settings)[this._index]))
                box.add_child(this._action(`Move to ${candidate.name}`, 'list-add-symbolic', () => assignGroup(settings, this._index, id, candidate.id)));
            box.add_child(this._action('Remove item', 'user-trash-symbolic', () => removeModule(settings, this._index, id)));
        }
        this._layoutActions(box, id);
        return box;
    }

    _layoutActions(box, id) {
        const settings = this._overlay._settings;
        const bar = readBars(settings)[this._index];
        const item = bar?.modules.find(module => module.id === id || module.group === id);
        if (!item)
            return;
        const place = item.place || 'center';
        box.add_child(new St.Label({text: 'On the bar', style: `color: ${this._theme.muted};`}));
        for (const spot of ['start', 'center', 'end'])
            box.add_child(this._action(spot === place ? `${spot[0].toUpperCase()}${spot.slice(1)} · here` : `${spot[0].toUpperCase()}${spot.slice(1)}`, 'object-flip-horizontal-symbolic', () => this._setModulePlace(id, spot)));
        box.add_child(this._action('Earlier', 'go-up-symbolic', () => this._nudgeModule(id, -1)));
        box.add_child(this._action('Later', 'go-down-symbolic', () => this._nudgeModule(id, 1)));
    }

    _setModulePlace(id, place) {
        const settings = this._overlay._settings;
        const bars = readBars(settings);
        const bar = bars[this._index];
        if (!bar)
            return;
        bar.modules = bar.modules.map(module => module.id === id || module.group === id ? {...module, place} : module);
        bar.groups = barGroups(bar).map(group => group.id === id ? {...group, place} : group);
        saveBars(settings, bars);
    }

    _nudgeModule(id, delta) {
        nudgeUnit(this._overlay._settings, this._index, id, delta);
    }

    _timeActions(box, bar) {
        const settings = this._overlay._settings;
        const gnome = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'}).get_string('clock-format');
        const format = barTimeFormat(bar, gnome);
        box.add_child(this._action(format === '12h' ? 'Use 24-hour time' : 'Use 12-hour time', 'preferences-system-time-symbolic', () => patchBar(settings, this._index, {timeFormat: format === '12h' ? '24h' : '12h'})));
        const clock = bar.modules.find(item => item.id === 'clock');
        const seconds = clock?.showSeconds ?? bar.clockSeconds === true;
        box.add_child(this._action(seconds ? 'Hide seconds' : 'Show seconds', 'appointment-soon-symbolic', () => clock
            ? patchModule(settings, this._index, 'clock', {showSeconds: !seconds})
            : patchBar(settings, this._index, {clockSeconds: !seconds})));
    }

    _dashboardClockActions(box) {
        const settings = this._overlay._settings;
        const date = settingChoice(settings, 'dashboard-date-format', 'long', Object.keys(DATE_FORMATS));
        for (const [key, item] of Object.entries(DATE_FORMATS))
            box.add_child(this._action(key === date ? `Dashboard · ${item.label} · on` : `Dashboard · ${item.label}`, 'x-office-calendar-symbolic', () => settings.set_string('dashboard-date-format', key)));
        const time = settingChoice(settings, 'dashboard-time-format', '24h', ['24h', '12h']);
        box.add_child(this._action(time === '12h' ? 'Dashboard · 24-hour time' : 'Dashboard · 12-hour time', 'preferences-system-time-symbolic', () => settings.set_string('dashboard-time-format', time === '12h' ? '24h' : '12h')));
        const seconds = settingFlag(settings, 'dashboard-clock-seconds');
        box.add_child(this._action(seconds ? 'Dashboard · hide seconds' : 'Dashboard · show seconds', 'appointment-soon-symbolic', () => settings.set_boolean('dashboard-clock-seconds', !seconds)));
    }

    _spacerMenu(box, item) {
        if (!item) return;
        box.add_child(new St.Label({text: `Empty space · ${item.size} px`}));
        for (const delta of [-8, 8])
            box.add_child(this._action(delta < 0 ? 'Shrink space (−8 px)' : 'Grow space (+8 px)',
                delta < 0 ? 'list-remove-symbolic' : 'list-add-symbolic', () => {
                    const current = readBars(this._overlay._settings)[this._index]?.modules.find(module => module.id === item.id);
                    if (current) resizeSpacer(this._overlay._settings, this._index, item.id, current.size + delta);
                }));
    }

    _addMenu(place) {
        const settings = this._overlay._settings;
        const bar = readBars(settings)[this._index];
        const used = new Set(bar.modules.map(item => item.id));
        const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style: 'spacing: 8px;'});
        box.add_child(this._action('Create group', 'list-add-symbolic', () => createGroup(settings, this._index, 'New group', [], place)));
        for (const group of barGroups(bar))
            box.add_child(this._action(`Remove group: ${group.name} · keep contents`, 'edit-clear-symbolic', () => deleteGroup(settings, this._index, group.id)));
        box.add_child(this._action('Empty space', 'content-loading-symbolic', () => addModule(settings, this._index, 'spacer', place)));
        for (const [id, title] of MODULES) {
            if (!used.has(id))
                box.add_child(this._action(title, 'list-add-symbolic', () => addModule(settings, this._index, id, place)));
        }
        return box;
    }

    _attachZone(zone, place, pinParent = null) {
        const content = zone._bezelZone ?? zone;
        this._alignZone(content, place);
        const apps = this._appsRow;
        const holdsApps = apps && content.contains(apps);
        if (holdsApps) {
            this._appsZone = content;
            this._appsPlace = place;
            this._centerApps = place === 'center';
            const parent = apps.get_parent();
            const index = parent.get_children().indexOf(apps);
            parent.remove_child(apps);
            const view = pinParent ? this._dockViewport : this._appsClip();
            const scroll = view._bezelScroll ?? view;
            // ScrollView owns internal scrollbar actors as well as its content.
            // Removing its children directly leaves native scrollbar references
            // pointing at detached (and eventually disposed) actors.
            scroll.set_child(apps);
            apps.x_expand = false;
            apps.y_expand = false;
            parent.insert_child_at_index(view, index);
            this._appViewport = view;
        }
        // Each zone is one packed row. Extra apps space is balanced around
        // the visible contents while the viewport owns the trailing edge.
        content.x_expand = this._vertical;
        content.y_expand = !this._vertical;
        if (pinParent) {
            zone._bezelEdge = place;
            if (zone.get_n_children())
                pinParent.add_child(zone);
            return null;
        }
        if (!holdsApps) {
            this._alignZone(zone, place);
            const cell = this._scrollView();
            cell.set_child(zone);
            if (this._state.sections !== 'pills' || pinParent || zone.visible === false)
                return cell;
            return this._sectionPill(cell, zone, place);
        }
        const cell = new St.Widget({layout_manager: new Clutter.BinLayout(),
            x_expand: false, y_expand: false, clip_to_allocation: false});
        if (this._state.sections === 'pills') {
            const plate = this._pillPlate(zone, place);
            cell.add_child(plate);
            cell._bezelPlate = plate;
        }
        cell.add_child(zone);
        cell._bezelPack = zone;
        return cell;
    }

    // The outer widget is the size of the visible window. The scroll view is
    // forced to that window, while the icon row keeps its real length inside it.
    _appsClip() {
        const scroll = new St.ScrollView({
            clip_to_allocation: true,
            overlay_scrollbars: true,
            reactive: true,
            x_expand: true,
            y_expand: true,
            // EXTERNAL keeps the overflow adjustment but never paints a bar.
            // The internal scrollbar actors must remain owned by ScrollView.
            hscrollbar_policy: this._vertical ? St.PolicyType.NEVER : St.PolicyType.EXTERNAL,
            vscrollbar_policy: this._vertical ? St.PolicyType.EXTERNAL : St.PolicyType.NEVER,
        });
        try {
            scroll.set_mouse_scrolling(false);
        } catch {
            /* Older Shell builds only expose the property. */
        }
        const clip = new St.Widget({
            clip_to_allocation: true,
            layout_manager: new Clutter.BinLayout(),
            reactive: true,
            x_expand: false,
            y_expand: false,
        });
        scroll.x_align = Clutter.ActorAlign.FILL;
        scroll.y_align = Clutter.ActorAlign.FILL;
        clip.add_child(scroll);
        clip._bezelScroll = scroll;
        return clip;
    }

    _appsAdjustment() {
        const scroll = this._appViewport?._bezelScroll ?? this._appViewport;
        if (!scroll)
            return null;
        return this._vertical ? scroll.vadjustment : scroll.hadjustment;
    }

    _scrollAppsBy(steps) {
        const adjustment = this._appsAdjustment();
        if (!adjustment || !steps)
            return false;
        const lower = adjustment.lower;
        const limit = adjustment.upper - adjustment.page_size;
        if (!(limit > lower + 0.5))
            return false;
        const stride = (this._state.iconSize || 22) + (this._state.appSpacing || 0) + 10;
        adjustment.value = clamp(adjustment.value + steps * stride, lower, limit);
        this._appsOffset = adjustment.value;
        this._appsScrollPin = adjustment.page_size;
        return true;
    }

    _scrollView() {
        const view = new St.ScrollView({
            clip_to_allocation: true, overlay_scrollbars: true, reactive: false,
            x_expand: false, y_expand: false,
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.NEVER,
        });
        this._wireHorizontalScroll(view);
        return view;
    }

    _contentCross() {
        if (this._vertical)
            return 0;
        let max = 0;
        for (const zone of Object.values(this._zones ?? {})) {
            if (!zone || zone.visible === false)
                continue;
            for (const child of zone.get_children()) {
                if (child.visible === false)
                    continue;
                const locked = child.height_set;
                const previous = child.height;
                if (locked)
                    child.height = -1;
                try {
                    const [, natural] = child.get_preferred_height(-1);
                    max = Math.max(max, natural || 0);
                } catch {
                    /* Actor can be mid-destroy while the bar is placed. */
                }
                if (locked)
                    child.height = previous;
            }
        }
        return max;
    }

    // Horizontal bars pack modules from the top of the clip, which slices the
    // first pixels of the clock. Stretch the row and center each module in it.
    _centerBarZone(cell) {
        const scroll = cell instanceof St.ScrollView ? cell
            : cell?._bezelPack instanceof St.ScrollView ? cell._bezelPack : null;
        const zone = scroll?.child ?? scroll?.get_child?.();
        if (!zone)
            return;
        const room = Math.max(1, cell.height || scroll.height || 0);
        if (room < 2)
            return;
        zone.y_expand = true;
        zone.y_align = Clutter.ActorAlign.CENTER;
        zone.height = room;
        for (const child of zone.get_children()) {
            child.y_expand = false;
            child.y_align = Clutter.ActorAlign.CENTER;
        }
    }

    _alignZone(zone, place) {
        const align = {start: Clutter.ActorAlign.START, center: Clutter.ActorAlign.CENTER,
            end: Clutter.ActorAlign.END}[place];
        zone.x_align = this._vertical ? Clutter.ActorAlign.CENTER : align;
        zone.y_align = this._vertical ? align : Clutter.ActorAlign.CENTER;
        zone.x_expand = this._vertical;
        zone.y_expand = !this._vertical;
    }

    _wireHorizontalScroll(view) {
        if (this._vertical) return;
        view.set_mouse_scrolling(false);
        view.connect('scroll-event', (_actor, event) => {
            view.vadjustment.value = view.vadjustment.lower;
            const adjustment = view.hadjustment;
            const limit = adjustment.upper - adjustment.page_size;
            if (limit <= adjustment.lower) return Clutter.EVENT_PROPAGATE;
            const delta = scrollStep(event);
            if (!delta) return Clutter.EVENT_PROPAGATE;
            adjustment.value = clamp(adjustment.value + delta * (this._state.iconSize + this._state.appSpacing + 10),
                adjustment.lower, limit);
            this._cancel('_appHover');
            return Clutter.EVENT_STOP;
        });
    }

    _zone() {
        const zone = new St.BoxLayout({
            orientation: this._content.orientation,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            style: this._zoneStyle(),
        });
        return zone;
    }

    _cornerInset() {
        if (!this._state.border || this._state.kind === 'dock' || this._state.margin || this._state.length < 100)
            return 0;
        return Math.max(0, this._state.radius || 0);
    }

    _barPadding() {
        // Narrow rails need room for value labels plus the group's fill padding.
        // Keep the viewport centred across the full rail, with a small gutter.
        return {along: 6 + Math.min(this._cornerInset(), 16), cross: 2};
    }

    _shadowDepth() {
        return barShadowDepth(this._state.barShadow, this._state.border);
    }

    _popupShadowDepth(attached) {
        if (attached)
            return 0;
        return Math.max(0, Number(this._state.shadow) || 0);
    }

    _popupCardStyle(radii) {
        const chrome = this._popupChromeStyle;
        const bg = this._popupPlate ? 'transparent' : chrome.bg;
        return `background-color: ${bg}; color: ${chrome.fg}; border-radius: ${radii}; padding: ${chrome.pad};`;
    }

    _popupBackdropPlate() {
        const holder = new St.Widget({
            layout_manager: new Clutter.FixedLayout(),
            x_expand: true, y_expand: true,
            reactive: false, clip_to_allocation: false,
        });
        const plate = new St.DrawingArea({reactive: false, clip_to_allocation: false});
        holder.add_child(plate);
        const sync = () => {
            const source = this._popout ?? holder;
            const depth = this._popupShadow ?? 0;
            const width = Math.max(1, source.width || holder.width);
            const height = Math.max(1, source.height || holder.height);
            const nextW = width + depth * 2;
            const nextH = height + depth * 2;
            if (plate.x !== -depth || plate.y !== -depth || plate.width !== nextW || plate.height !== nextH) {
                plate.set_position(-depth, -depth);
                plate.set_size(nextW, nextH);
            }
            plate.queue_repaint();
        };
        holder._bezelSyncPlate = sync;
        holder.connect('notify::allocation', () => sync());
        plate.connect('repaint', () => {
            let cr;
            try {
                cr = plate.get_context();
            } catch {
                return;
            }
            if (!cr)
                return;
            try {
                const [sw, sh] = plate.get_surface_size();
                const width = plate.width;
                const height = plate.height;
                if (width <= 0 || height <= 0)
                    return;
                if (sw > 0 && sh > 0)
                    cr.scale(sw / width, sh / height);
                const depth = this._popupShadow ?? 0;
                paintPillBackdrop(cr, {
                    x: depth, y: depth,
                    w: Math.max(1, width - depth * 2),
                    h: Math.max(1, height - depth * 2),
                }, this._popupPaintRadius ?? this._state.radius, this._theme.bg, 1, depth);
            } finally {
                cr.$dispose();
            }
        });
        return holder;
    }

    _backdropPlate(paint) {
        // A fixed child can extend beyond the cell without changing bar sizing
        // or the input region. Only the app scroll view clips its contents.
        // Size the plate from the actor after layout; a 0×0 holder with bind
        // constraints can stay empty on a second bar (hybrid dock).
        const holder = new St.Widget({layout_manager: new Clutter.FixedLayout(),
            x_expand: true, y_expand: true,
            reactive: false, clip_to_allocation: false});
        const plate = new St.DrawingArea({reactive: false, clip_to_allocation: false});
        holder.add_child(plate);
        const sync = () => {
            const source = holder.get_parent() ?? holder;
            const depth = this._shadowDepth();
            const width = Math.max(1, source.width || holder.width);
            const height = Math.max(1, source.height || holder.height);
            const nextW = width + depth * 2;
            const nextH = height + depth * 2;
            if (plate.x !== -depth || plate.y !== -depth || plate.width !== nextW || plate.height !== nextH) {
                plate.set_position(-depth, -depth);
                plate.set_size(nextW, nextH);
            }
            plate.queue_repaint();
        };
        holder._bezelSyncPlate = sync;
        holder.queue_repaint = sync;
        holder.connect('notify::allocation', () => sync());
        this._actor.connectObject('notify::allocation', () => sync(), holder);
        plate.connect('repaint', () => paint(plate));
        return holder;
    }

    _pillPlate(zone, place) {
        const holder = this._backdropPlate(area => this._paintSectionPill(area, zone, place));
        zone.connectObject('notify::allocation', () => holder.queue_repaint(), holder);
        return holder;
    }

    _paintBarBackdrop(area) {
        let cr;
        try {
            cr = area.get_context();
        } catch {
            return;
        }
        if (!cr)
            return;
        try {
            const [sw, sh] = area.get_surface_size();
            const width = area.width;
            const height = area.height;
            if (width <= 0 || height <= 0) return;
            if (sw > 0 && sh > 0)
                cr.scale(sw / width, sh / height);
            const depth = this._shadowDepth();
            const radius = this._state.kind === 'dock' || this._state.margin || this._state.length < 100
                ? this._state.rounding : 0;
            paintPillBackdrop(cr, {x: depth, y: depth,
                w: Math.max(1, width - depth * 2), h: Math.max(1, height - depth * 2)},
            radius, this._theme.bg, this._state.barOpacity / 100, depth);
        } finally {
            cr.$dispose();
        }
    }

    _sectionPill(scroll, zone, place) {
        const plate = this._pillPlate(zone, place);
        scroll.clip_to_allocation = false;
        scroll.x_expand = true;
        scroll.y_expand = true;
        const bin = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            clip_to_allocation: false,
        });
        bin.add_child(plate);
        bin.add_child(scroll);
        bin._bezelPack = scroll;
        bin._bezelPlate = plate;
        return bin;
    }

    _paintSectionPill(area, zone, place) {
        let cr;
        try {
            cr = area.get_context();
        } catch {
            return;
        }
        if (!cr)
            return;
        try {
            if (this._state.barOpacity === 0) return;
            const [sw, sh] = area.get_surface_size();
            const width = Math.max(1, area.width || sw);
            const height = Math.max(1, area.height || sh);
            if (width < 2 || height < 2)
                return;
            if (sw > 0 && sh > 0)
                cr.scale(sw / width, sh / height);
            const vertical = this._vertical;
            const along = vertical ? height : width;
            // Measure the allocated children, not the recursive preferred-size
            // estimate (or the zone's synthetic alignment padding).
            const [ax, ay] = area.get_transformed_position();
            const [aw, ah] = area.get_transformed_size();
            const scale = vertical ? ah / height : aw / width;
            const bounds = zone.get_children().filter(child => child.visible).map(child => {
                const [x, y] = child.get_transformed_position();
                const [w, h] = child.get_transformed_size();
                const start = ((vertical ? y : x) - (vertical ? ay : ax)) / (scale || 1);
                return [start, start + (vertical ? h : w) / (scale || 1)];
            });
            if (!bounds.length)
                return;
            const inset = 2 + this._shadowDepth();
            const offset = Math.max(inset, Math.min(...bounds.map(b => b[0])) - 6);
            const end = Math.min(along - inset, Math.max(...bounds.map(b => b[1])) + 6);
            const span = Math.max(1, end - offset);
            const shadowInset = inset;
            const rect = vertical
                ? {x: inset, y: offset, w: Math.max(1, width - inset - shadowInset), h: span}
                : {x: offset, y: inset, w: span, h: Math.max(1, height - inset - shadowInset)};
            paintPillBackdrop(cr, rect, Math.min(18, rect.w / 2, rect.h / 2), this._theme.bg,
                (this._state.barOpacity ?? 100) / 100, this._shadowDepth());
        } finally {
            cr.$dispose();
        }
    }

    _zoneStyle(extra = '') {
        const pills = this._state.sections === 'pills';
        const pad = pills ? ` padding: ${this._vertical ? '10px 0px' : '0px 10px'};` : '';
        return `spacing: ${pills ? 8 : 12}px;${pad}${extra}`;
    }

    _drag(actor, id) {
        const press = global.stage.connect('captured-event', (_stage, event) => {
            if (event.type() !== Clutter.EventType.BUTTON_PRESS || event.get_button() !== 1)
                return Clutter.EVENT_PROPAGATE;
            const [sx, sy] = event.get_coords();
            const picked = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, sx, sy);
            if (picked !== actor && !actor.contains(picked))
                return Clutter.EVENT_PROPAGATE;
            if (id === 'apps' && actor.get_children().some(child => child === picked || child.contains(picked)))
                return Clutter.EVENT_PROPAGATE;
            // Extension icons reorder inside the slot. Let that gesture run.
            if (id === 'indicators' && actor.get_children().some(child => child._bezelRole && (child === picked || child.contains(picked))))
                return Clutter.EVENT_PROPAGATE;
            this._endDrag();
            let moved = false;
            this._dragActor = actor;
            this._dragWatch = global.stage.connect('captured-event', (_target, ev) => {
                const [x, y] = global.get_pointer();
                if (ev.type() === Clutter.EventType.KEY_PRESS && ev.get_key_symbol() === Clutter.KEY_Escape) {
                    this._endDrag();
                    return Clutter.EVENT_STOP;
                }
                if (ev.type() === Clutter.EventType.MOTION) {
                    if (Math.hypot(x - sx, y - sy) > 12) {
                        moved = true;
                        actor.translation_x = this._vertical ? 0 : x - sx;
                        actor.translation_y = this._vertical ? y - sy : 0;
                    }
                    return Clutter.EVENT_STOP;
                }
                if (ev.type() === Clutter.EventType.BUTTON_RELEASE) {
                    this._endDrag();
                    if (moved)
                        this._overlay.moveModule(this._index, id, this._vertical ? y : x, this);
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            });
            return Clutter.EVENT_STOP;
        });
        this._signals.push([global.stage, press]);
    }

    _dragItem(actor, siblings, save) {
        if (!this._state.editMode) return;
        const press = global.stage.connect('captured-event', (_stage, event) => {
            if (event.type() !== Clutter.EventType.BUTTON_PRESS || event.get_button() !== 1)
                return Clutter.EVENT_PROPAGATE;
            const [sx, sy] = event.get_coords();
            const picked = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, sx, sy);
            if (picked !== actor && !actor.contains(picked)) return Clutter.EVENT_PROPAGATE;
            this._close();
            this._endDrag();
            this._dragActor = actor;
            let moved = false;
            this._dragWatch = global.stage.connect('captured-event', (_target, ev) => {
                const [x, y] = ev.get_coords();
                if (ev.type() === Clutter.EventType.KEY_PRESS && ev.get_key_symbol() === Clutter.KEY_Escape) {
                    this._endDrag();
                    return Clutter.EVENT_STOP;
                }
                if (ev.type() === Clutter.EventType.MOTION) {
                    moved ||= Math.hypot(x - sx, y - sy) > 12;
                    if (moved) {
                        actor.translation_x = this._vertical ? 0 : x - sx;
                        actor.translation_y = this._vertical ? y - sy : 0;
                    }
                    return Clutter.EVENT_STOP;
                }
                if (ev.type() === Clutter.EventType.BUTTON_RELEASE) {
                    this._endDrag();
                    if (moved) {
                        const others = siblings().filter(item => item !== actor);
                        const coordinate = this._vertical ? y : x;
                        let index = others.findIndex(item => {
                            const [ix, iy] = item.get_transformed_position();
                            const [iw, ih] = item.get_transformed_size();
                            return coordinate < (this._vertical ? iy + ih / 2 : ix + iw / 2);
                        });
                        if (index < 0) index = others.length;
                        others.splice(index, 0, actor);
                        save(others);
                    }
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            });
            return Clutter.EVENT_STOP;
        });
        let connected = true;
        const cleanup = () => {
            if (!connected) return;
            connected = false;
            global.stage.disconnect(press);
            if (this._dragActor === actor) this._endDrag();
        };
        const destroyed = actor.connect('destroy', cleanup);
        return () => { cleanup(); actor.disconnect(destroyed); };
    }

    _wire(actor) {
        if (actor instanceof St.Button) {
            actor.can_focus = true;
            actor.add_style_class_name('bezel-button');
            actor.connect('clicked', () => {
                if (actor._recordingStop && screenshotRecording()) {
                    actor._recordingStop();
                    return;
                }
                actor._activate?.();
            });
        }
    }

    _endDrag() {
        if (this._dragWatch) {
            global.stage.disconnect(this._dragWatch);
            this._dragWatch = 0;
        }
        if (this._dragActor) {
            this._dragActor.translation_x = 0;
            this._dragActor.translation_y = 0;
            this._dragActor = null;
        }
    }

    _later(key, delay, callback) {
        if (this._destroyed)
            return;
        this._cancel(key);
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._timers.delete(id);
            this[key] = 0;
            callback();
            return GLib.SOURCE_REMOVE;
        });
        this[key] = id;
        this._timers.add(id);
    }

    _cancel(key) {
        if (!this[key])
            return;
        if (this._timers.has(this[key]))
            GLib.source_remove(this[key]);
        this._timers.delete(this[key]);
        this[key] = 0;
    }

    _boxSpacing(actor) {
        const match = /spacing:\s*(\d+(?:\.\d+)?)/.exec(actor?.style ?? '');
        return match ? Number(match[1]) : 0;
    }

    _longPreferred(actor) {
        return this._vertical ? actor.get_preferred_height(-1) : actor.get_preferred_width(-1);
    }

    // Sum the real contents. A scroll view reports the space it was last given,
    // which kept the apps clipped while empty space sat beside them.
    _contentSpan(actor, depth = 0, raw = false) {
        if (!actor || depth > 14)
            return 0;
        try {
            if (actor._bezelBalance || actor.visible === false)
                return 0;
            if (actor._bezelVertical)
                return Math.max(0, actor.height || 0);
            if (actor === this._appViewport && this._appsRow) {
                const inner = this._iconRowSpan(this._appsRow);
                return raw ? inner : Math.max(0, this._appsLimit(inner) - this._appsLeadingSpace());
            }
            if (actor._bezelPack)
                return this._contentSpan(actor._bezelPack, depth + 1, raw);
            if (actor._bezelApps)
                return this._iconRowSpan(actor);
            if (actor instanceof St.ScrollView) {
                const inner = this._contentSpan(actor.child ?? actor.get_child?.(), depth + 1, raw);
                return !raw && actor === this._appViewport
                    ? this._appsLimit(inner) - this._appsLeadingSpace() : inner;
            }
            if (actor instanceof St.Button) {
                const child = actor.child ?? actor.get_child?.();
                if (child && this._vertical) {
                    const inner = this._contentSpan(child, depth + 1, raw);
                    if (inner > 0)
                        return inner;
                }
                const [, size] = this._longPreferred(actor);
                return size || 0;
            }
            const children = actor.get_n_children?.() > 0 ? actor.get_children() : [];
            if (children.length && actor instanceof St.BoxLayout) {
                let total = 0;
                let shown = 0;
                for (const child of children) {
                    if (child.visible === false)
                        continue;
                    total += this._contentSpan(child, depth + 1, raw);
                    shown++;
                }
                const node = actor.get_theme_node();
                const padding = actor._bezelGroupPadding
                    ? (this._vertical ? node.get_vertical_padding() : node.get_horizontal_padding())
                    : (actor._bezelAlongPad || 0);
                // Non-scrolling groups must never be sized below their real
                // preferred width, including wide labels and themed controls.
                if (actor._bezelGroupPadding && !actor.contains(this._appViewport ?? this._actor)) {
                    const [, natural] = this._longPreferred(actor);
                    return Math.max(natural, total + padding);
                }
                return total + Math.max(0, shown - 1) * this._boxSpacing(actor) + padding +
                    (!raw && actor === this._appsZone ? this._appsLeadingSpace() : 0);
            }
            const [, size] = this._longPreferred(actor);
            return size || 0;
        } catch {
            return 0;
        }
    }

    // The apps row is the icons themselves. A stretched allocation would leave
    // a gap after the last icon and would not shrink when an app closes.
    _iconRowSpan(box) {
        const icons = box.get_children().filter(child => child.visible !== false);
        const count = icons.length;
        if (!count)
            return 0;
        const each = (this._state.iconSize || 22) + 16;
        const stretched = Math.max(each * 4, 180);
        let total = 0;
        for (const icon of icons) {
            let size = 0;
            try {
                size = this._longPreferred(icon)[1] || 0;
            } catch {
                size = 0;
            }
            total += size > 0 && size <= stretched ? size : each;
        }
        return total + Math.max(0, count - 1) * (this._state.appSpacing || 0);
    }

    // 0 follows the icons. A longer drag is a minimum and still grows when more apps open.
    // A shorter drag is a cap, and the apps scroll inside it.
    _appsLimit(natural) {
        const chosen = this._chosenApps();
        if (!chosen)
            return natural;
        return this._layoutAppsCap ? chosen : Math.max(chosen, natural);
    }

    _appsLeadingSpace() {
        if (!this._appsRow || this._appsPlace === 'start')
            return 0;
        const natural = this._iconRowSpan(this._appsRow);
        const extra = Math.max(0, this._appsLimit(natural) - natural);
        if (!extra)
            return 0;
        return this._appsPlace === 'end' ? extra : extra / 2;
    }

    _sizeAppsViewport(room, cross) {
        const view = this._appViewport ?? this._dockViewport;
        const natural = this._contentSpan(view, 0, true);
        const desired = Math.max(1, this._appsLimit(natural));
        // A minimum reserves a total footprint, shared before the logo and
        // after the apps. Closing apps cannot make the dock grow wider.
        const footprint = Math.max(1, Math.min(desired, room));
        const extra = Math.max(0, footprint - natural);
        const leading = this._appsPlace === 'end' ? extra : this._centerApps ? extra / 2 : 0;
        const length = footprint - leading;
        if (this._appsZone && this._state.sections !== 'pills') {
            const side = this._vertical ? 'top' : 'left';
            this._appsZone.style = `spacing: 12px; padding-${side}: ${leading}px;`;
            this._applyAppsAlign(this._appsZone);
        }
        view.x_expand = false;
        view.y_expand = false;
        view.clip_to_allocation = true;
        view._bezelCap = length;
        this._applyAppsAlign(view);
        // The scroll window contains icons, not the surrounding group's padding.
        // Giving it the full bar thickness feeds that allocation back into the
        // next preferred-size measurement and grows the bar on every placement.
        const naturalCross = this._appsRow
            ? (this._vertical ? this._appsRow.get_preferred_width(-1)[1] : this._appsRow.get_preferred_height(-1)[1])
            : cross;
        const fittedCross = Math.max(1, Math.min(cross, naturalCross || cross));
        view.set_size(this._vertical ? fittedCross : length, this._vertical ? length : fittedCross);
        this._syncAppsScrollRange(length);
        return length + leading;
    }

    _placeAppsRow() {
        const row = this._appsRow;
        if (!row)
            return;
        // A forced length makes the scroll view think the icons already fit.
        row.x_expand = false;
        row.y_expand = false;
        row.translation_x = 0;
        row.translation_y = 0;
        try {
            if (this._vertical)
                row.set_height(-1);
            else
                row.set_width(-1);
        } catch {
            /* The row keeps whatever size the icons ask for. */
        }
    }

    // Start hugs the start of its section, end hugs the end. Only the center floats in the middle.
    _applyAppsAlign(actor) {
        if (!actor)
            return;
        const along = this._appsPlace === 'end' ? Clutter.ActorAlign.END
            : this._appsPlace === 'start' ? Clutter.ActorAlign.START
            : Clutter.ActorAlign.CENTER;
        if (this._vertical) {
            actor.x_align = Clutter.ActorAlign.CENTER;
            actor.y_align = along;
        } else {
            actor.x_align = along;
            actor.y_align = Clutter.ActorAlign.CENTER;
        }
    }

    // The row has to keep its real length, or a short viewport has nothing to scroll.
    _syncAppsScrollRange(length) {
        const row = this._appsRow;
        if (!row)
            return;
        const capped = this._layoutAppsCap && this._chosenApps() > 0;
        if (!capped)
            this._appsOffset = 0;
        else if (this._appsPlace === 'end' && this._appsScrollPin !== length)
            this._appsOffset = Number.MAX_SAFE_INTEGER;
        this._appsScrollPin = capped ? length : 0;
        this._placeAppsRow();
        this._queueAppsOffset();
    }

    _queueAppsOffset() {
        if (this._destroyed || this._appsOffsetLater)
            return;
        this._appsOffsetLater = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._appsOffsetLater = 0;
            this._applyAppsOffset();
            return GLib.SOURCE_REMOVE;
        });
    }

    _applyAppsOffset() {
        const adjustment = this._appsAdjustment();
        if (!adjustment)
            return;
        const lower = adjustment.lower;
        const limit = adjustment.upper - adjustment.page_size;
        if (!(limit > lower + 0.5))
            return;
        adjustment.value = clamp(this._appsOffset || 0, lower, limit);
        this._appsOffset = adjustment.value;
    }

    _sectionSpans() {
        const view = this._dockViewport;
        const content = this._dockContent;
        if (content && view && view.get_parent() === content) {
            const children = content.get_children().filter(child => child.visible !== false);
            const index = children.indexOf(view);
            const before = children.slice(0, Math.max(0, index)).reduce((sum, child) => sum + this._contentSpan(child), 0);
            const after = index < 0 ? 0 : children.slice(index + 1).reduce((sum, child) => sum + this._contentSpan(child), 0);
            return [before, this._contentSpan(view), after];
        }
        return ['start', 'center', 'end'].map(place => {
            const zone = this._zones?.[place];
            if (!zone || !zone.visible)
                return 0;
            // St knows button padding and the orientation of nested boxes.
            // Only apps need a recursive measurement of their scroll window.
            if (zone.contains(this._appViewport ?? this._actor))
                return this._contentSpan(zone);
            return this._longPreferred(zone)[1];
        });
    }

    _fitDock(outerW, outerH) {
        const content = this._dockContent;
        const view = this._dockViewport;
        if (!content || !view || !content.contains(view))
            return;
        for (const child of [...content.get_children()])
            if (child._bezelBalance)
                content.remove_child(child);
        const children = content.get_children().filter(child => child.visible !== false);
        const apps = Math.max(1, this._contentSpan(view));
        const others = Math.max(0, this._contentSpan(content) - apps - this._appsLeadingSpace() -
            this._boxSpacing(content) * Math.max(0, children.length - 1));
        for (const child of children) {
            if (child === view)
                continue;
            child.x_expand = false;
            child.y_expand = false;
            child.x_align = Clutter.ActorAlign.CENTER;
            child.y_align = Clutter.ActorAlign.CENTER;
        }
        const gaps = this._boxSpacing(content) * Math.max(0, children.length - 1);
        const along = Math.max(1, this._vertical ? outerH : outerW);
        const cross = Math.max(1, this._vertical ? outerW : outerH);
        const room = Math.max(1, along - others - gaps);
        const appsSpan = this._sizeAppsViewport(room, cross);
        const pinEdge = this._appsPlace === 'start' || this._appsPlace === 'end';
        if (pinEdge) {
            this._anchorDockCenter(content, along, cross);
            return;
        }
        let packed = Math.min(along, others + appsSpan + gaps);
        const centerIndex = children.findIndex(child => child._bezelEdge === 'center');
        let padding = '';
        if (centerIndex >= 0) {
            const sideSpan = side => side.reduce((sum, child) => sum + this._contentSpan(child), 0) +
                side.length * this._boxSpacing(content);
            const before = sideSpan(children.slice(0, centerIndex));
            const after = sideSpan(children.slice(centerIndex + 1));
            const balance = Math.abs(before - after);
            if (packed + balance <= along) {
                const side = this._vertical ? (before < after ? 'top' : 'bottom')
                    : (before < after ? 'left' : 'right');
                padding = ` padding-${side}: ${balance}px;`;
                packed += balance;
            }
        }
        content.style = `spacing: 12px;${padding}`;
        // Center the packed row; requested apps space is already inside view.
        content.x_expand = this._vertical;
        content.y_expand = !this._vertical;
        content.x_align = Clutter.ActorAlign.CENTER;
        content.y_align = Clutter.ActorAlign.CENTER;
        content.set_size(this._vertical ? cross : packed, this._vertical ? packed : cross);
    }

    // Apps stay on the start or end edge. The center group stays on the bar midpoint,
    // so a shorter apps window must not drag that group with it.
    _anchorDockCenter(content, along, cross) {
        const startZone = content.get_children().find(child => child._bezelEdge === 'start');
        const centerZone = content.get_children().find(child => child._bezelEdge === 'center');
        const endZone = content.get_children().find(child => child._bezelEdge === 'end');
        const placeZone = (zone, edge) => {
            if (!zone)
                return;
            const alongAlign = edge === 'end' ? Clutter.ActorAlign.END
                : edge === 'center' ? Clutter.ActorAlign.CENTER
                : Clutter.ActorAlign.START;
            zone.x_expand = false;
            zone.y_expand = false;
            if (this._vertical) {
                zone.x_align = Clutter.ActorAlign.CENTER;
                zone.y_align = alongAlign;
            } else {
                zone.x_align = alongAlign;
                zone.y_align = Clutter.ActorAlign.CENTER;
            }
        };
        placeZone(startZone, 'start');
        placeZone(centerZone, 'center');
        placeZone(endZone, 'end');
        const spanOf = zone => zone ? this._contentSpan(zone) : 0;
        const fitZone = zone => {
            if (!zone)
                return;
            const need = Math.max(1, Math.round(spanOf(zone)));
            if (this._vertical)
                zone.set_height(need);
            else
                zone.set_width(need);
        };
        fitZone(startZone);
        fitZone(centerZone);
        fitZone(endZone);
        const startSpan = spanOf(startZone);
        const centerSpan = spanOf(centerZone);
        const endSpan = spanOf(endZone);
        if (!centerZone) {
            const spacer = new St.Widget({
                x_expand: !this._vertical, y_expand: this._vertical,
            });
            spacer._bezelBalance = true;
            const endAt = content.get_children().findIndex(child => child._bezelEdge === 'end');
            content.insert_child_at_index(spacer, endAt < 0 ? content.get_n_children() : endAt);
            content.style = 'spacing: 12px;';
        } else {
            const gap = 12;
            const earliest = startSpan + (startZone ? gap : 0);
            const latest = along - endSpan - (endZone ? gap : 0) - centerSpan;
            let centerTop = (along - centerSpan) / 2;
            if (latest >= earliest)
                centerTop = clamp(centerTop, earliest, latest);
            else
                centerTop = earliest;
            const before = Math.max(0, centerTop - startSpan);
            const after = Math.max(0, along - endSpan - centerTop - centerSpan);
            const spacer = size => {
                const widget = new St.Widget({x_expand: false, y_expand: false});
                widget._bezelBalance = true;
                const length = Math.max(1, Math.round(size));
                widget.set_size(this._vertical ? 1 : length, this._vertical ? length : 1);
                return widget;
            };
            content.style = 'spacing: 0;';
            const centerAt = content.get_children().indexOf(centerZone);
            if (before > 0)
                content.insert_child_at_index(spacer(before), centerAt);
            if (after > 0)
                content.insert_child_at_index(spacer(after), content.get_children().indexOf(centerZone) + 1);
        }
        content.x_expand = true;
        content.y_expand = true;
        content.set_size(this._vertical ? cross : along, this._vertical ? along : cross);
    }

    // The side cell is tall so the center group can sit on the bar midpoint.
    // The apps themselves stay only as tall as their window and hug the outer edge.
    _pinEdgeZones() {
        const place = this._appsPlace;
        const zone = this._appsZone;
        if (!zone || this._dockContent || (place !== 'start' && place !== 'end'))
            return;
        const need = Math.max(1, Math.round(this._contentSpan(zone)));
        const edge = place === 'end' ? Clutter.ActorAlign.END : Clutter.ActorAlign.START;
        // BinLayout honors ActorAlign on expanding axes; otherwise its default
        // CENTER alignment moves the whole pack inward when the apps shrink.
        // The explicit size below keeps the pack compact within the full cell.
        zone.x_expand = true;
        zone.y_expand = true;
        if (this._vertical) {
            zone.x_align = Clutter.ActorAlign.CENTER;
            zone.y_align = edge;
            zone.set_height(need);
        } else {
            zone.y_align = Clutter.ActorAlign.CENTER;
            zone.x_align = edge;
            zone.set_width(need);
        }
    }

    _place(overrides = null) {
        overrides ??= this._geomDrag?.pending;
        this._layoutApps = overrides && overrides.appsLength != null
            ? overrides.appsLength
            : (this._state.appsLength || 0);
        this._layoutAppsCap = overrides && overrides.appsCap != null
            ? overrides.appsCap === true
            : this._state.appsCap === true;
        let {x, y, width, height} = this._monitor;
        // Attached vertical rails own the corners; horizontal bars fit between them.
        if (!this._vertical) {
            const occupied = edge => Math.max(0, ...this._state.bars.filter(bar =>
                bar.edge === edge && bar.kind !== 'dock' && !bar.margin && bar.length === 100)
                .map(bar => bar.thickness));
            const left = occupied('left');
            width = Math.max(this._state.thickness, width - left - occupied('right'));
            x += left;
        }
        const edge = this._state.edge;
        let span = overrides?.thickness ?? this._state.thickness;
        if (!this._vertical) {
            const crossPad = this._barPadding();
            const needed = Math.ceil(this._contentCross() + crossPad.cross * 2 + 8);
            span = Math.max(span, Math.min(88, needed));
        }
        let px = x;
        let py = y;
        let w = width;
        let h = height;
        if (edge === 'left')
            w = span;
        else if (edge === 'right') {
            px = x + width - span;
            w = span;
        } else if (edge === 'top')
            h = span;
        else {
            py = y + height - span;
            h = span;
        }
        const margin = overrides?.margin ?? this._state.margin;
        const maxLength = (this._vertical ? height : width) - margin * 2;
        const configured = maxLength * (overrides?.length ?? this._state.length) / 100;
        const [startSize, centerSize, endSize] = this._sectionSpans();
        const dockReal = this._dockContent?.get_children().filter(child => !child._bezelBalance && child.visible !== false) ?? [];
        const dockGaps = this._dockContent
            ? this._boxSpacing(this._dockContent) * Math.max(0, dockReal.length - 1) : 0;
        const packed = startSize + centerSize + endSize + dockGaps + 28;
        const centered = 2 * Math.max(startSize, endSize) + centerSize + 28;
        // Reserve symmetric room around the center group when it fits.
        // Requested extra apps length remains part of that group.
        const needed = Math.max(packed, centered + dockGaps);
        let length = configured;
        if (this._state.kind === 'dock' && this._state.fitContent)
            length = Math.max(span, overrides?.dockMinLength ?? this._state.dockMinLength, needed);
        else if (this._state.kind !== 'dock')
            length = Math.max(configured, needed);
        length = Math.min(maxLength, length);
        if (this._vertical) {
            py = y + (height - length) / 2;
            h = length;
            px += edge === 'left' ? margin : -margin;
        } else {
            px = x + (width - length) / 2;
            w = length;
            py += edge === 'top' ? margin : -margin;
        }
        this._box = {x: px, y: py, width: w, height: h};
        this._actor.set_position(px, py);
        this._actor.set_size(w, h);
        this._backdrop?._bezelSyncPlate?.();
        if (this._dockContent)
            this._dockContent.set_size(Math.max(1, w - 12), Math.max(1, h - 12));
        else
            this._dockViewport?.set_size(Math.max(1, w - 12), Math.max(1, h - 12));
        const pad = this._barPadding();
        const innerAlong = Math.max(1, (this._vertical ? h : w) - pad.along * 2);
        const innerCross = Math.max(1, (this._vertical ? w : h) - pad.cross * 2);
        this._fitDock(innerAlong, innerCross);
        const placed = zonePlacement(innerAlong, [startSize, centerSize, endSize]);
        const sizes = placed.sizes.map(value => Math.max(0, Math.round(value)));
        let before = Math.max(0, Math.round(placed.before));
        let after = Math.max(0, Math.round(placed.after));
        let drift = Math.round(innerAlong - (sizes[0] + sizes[1] + sizes[2] + before + after));
        if (drift >= 0)
            after += drift;
        else {
            const take = Math.min(before + after, -drift);
            const fromAfter = Math.min(after, take);
            after -= fromAfter;
            before -= take - fromAfter;
        }
        for (const [index, cell] of (this._cells ?? []).entries()) {
            if (!cell)
                continue;
            const pinned = (this._appsPlace === 'start' || this._appsPlace === 'end')
                && (cell === this._appViewport || cell.contains?.(this._appViewport));
            const along = cell.visible === false ? 0 : sizes[index] ?? 0;
            // Only the cross axis fills the bar. The along size is the content,
            // so a zone cell never keeps an empty cut beside its colour group.
            cell.x_expand = this._vertical && !pinned;
            cell.y_expand = !this._vertical && !pinned;
            cell._bezelAlong = along;
            cell.set_size(this._vertical ? innerCross : along, this._vertical ? along : innerCross);
            cell._bezelPlate?.queue_repaint();
            if (!this._vertical)
                this._centerBarZone(cell);
        }
        if (this._zoneGaps) {
            const [lead, trail] = this._zoneGaps;
            const placeGap = (widget, length) => {
                widget.visible = length >= 1;
                widget.set_size(this._vertical ? Math.max(1, innerCross) : length,
                    this._vertical ? length : Math.max(1, innerCross));
            };
            placeGap(lead, before);
            placeGap(trail, after);
        }
        // _alignZone already anchors the opposite zone at its outer edge.
        // Padding a scrollable St.BoxLayout to fill its cell leaves visible
        // buttons outside its pick region, so they stop receiving clicks.
        this._alignAppsContents();
        this._pinEdgeZones();
        this._layoutEditHandles();
        if (this._state.border && this._state.kind !== 'dock' && !margin && this._state.length === 100) {
            this._overlay._frames.get(this._monitor.index)?.setReveal(this._index, edge, span,
                this._state.autohide ? (this._revealProgress ?? 0) : 1);
        }
    }

    _chosenApps() {
        const value = Number(this._layoutApps);
        return value > 0 ? clamp(Math.round(value), 48, 2400) : 0;
    }

    // Icons stay against the logo; excess space is balanced around the visible row.
    _alignAppsContents() {
        const view = this._appViewport;
        if (!view)
            return;
        view.reactive = true;
        view.clip_to_allocation = true;
        this._applyAppsAlign(view);
        const child = this._appsRow;
        if (child) {
            child.x_expand = false;
            child.y_expand = false;
        }
        const parent = view.get_parent();
        if (parent && parent !== this._actor && !this._dockContent && this._box) {
            const cell = this._cells.find(candidate => candidate.contains(view));
            const pack = cell?._bezelPack;
            const budget = cell?._bezelAlong ?? 1;
            const others = pack ? Math.max(0, this._contentSpan(pack) - this._contentSpan(view) - this._appsLeadingSpace()) : 0;
            const room = Math.max(1, budget - others);
            const cross = Math.max(1, this._vertical ? this._box.width - 12 : this._box.height - 12);
            this._sizeAppsViewport(room, cross);
        }
        if (!this._appsAllocWatch) {
            this._appsAllocWatch = view.connect('notify::allocation', () => {
                this._queueAppsHandle();
                this._applyAppsOffset();
            });
            this._signals.push([view, this._appsAllocWatch]);
        }
    }

    _ensureEditHandles() {
        if (!this._state.editMode || this._editHandles)
            return;
        const make = (name, mark) => {
            const button = new St.Button({
                label: mark,
                reactive: true,
                can_focus: true,
                width: 22,
                height: 22,
                accessible_name: name,
                style: `background-color: ${this._theme.accent}; color: ${this._theme.bg}; border: 2px solid ${this._theme.bg}; border-radius: 11px; font-size: 12px; font-weight: bold;`,
            });
            chrome(button, true);
            return button;
        };
        const end = make('Drag along the bar to change its length, or across it to change thickness', this._vertical ? '↕' : '↔');
        const gap = make('Drag to move the bar from the edge', this._vertical ? '↔' : '↕');
        end.connect('button-press-event', (_actor, event) => this._beginGeom(event, 'size'));
        gap.connect('button-press-event', (_actor, event) => this._beginGeom(event, 'distance'));
        const apps = new St.Button({
            label: '–',
            reactive: true,
            can_focus: true,
            width: 48,
            height: 14,
            accessible_name: 'Drag this edge to set where the apps stop',
            style: `background-color: ${this._theme.accent}; color: ${this._theme.bg}; border: 2px solid ${this._theme.bg}; border-radius: 8px; font-size: 11px; font-weight: bold;`,
        });
        chrome(apps, true);
        apps.connect('button-press-event', (_actor, event) => this._beginGeom(event, 'apps'));
        apps.visible = false;
        this._editHandles = {end, gap, apps};
        this._layoutEditHandles();
    }

    _layoutEditHandles() {
        const handles = this._editHandles;
        const box = this._box;
        if (!handles || !box)
            return;
        const size = 22;
        const edge = this._state.edge;
        const monitor = this._monitor;
        const place = (button, px, py) => button.set_position(
            Math.round(clamp(px, monitor.x + 4, monitor.x + monitor.width - size - 4)),
            Math.round(clamp(py, monitor.y + 4, monitor.y + monitor.height - size - 4)));
        if (this._vertical) {
            place(handles.end, box.x + (box.width - size) / 2, box.y + box.height - size * 0.35);
            place(handles.gap, edge === 'left' ? box.x - size - 6 : box.x + box.width + 6, box.y + box.height - size * 2 - 8);
        } else {
            place(handles.end, box.x + box.width - size * 0.35, box.y + (box.height - size) / 2);
            place(handles.gap, box.x + box.width - size * 2 - 8, edge === 'top' ? box.y - size - 6 : box.y + box.height + 6);
        }
        this._queueAppsHandle();
    }

    _queueAppsHandle() {
        if (this._destroyed || !this._editHandles?.apps || this._appsHandleLater)
            return;
        // Runs after the entire actor tree has allocated, including parent moves.
        this._appsHandleLater = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._appsHandleLater = 0;
            this._snapAppsHandle();
            return GLib.SOURCE_REMOVE;
        });
    }

    _placeAppsHandleAt(along) {
        const handle = this._editHandles?.apps;
        const box = this._box;
        if (!handle || !box || !Number.isFinite(along))
            return;
        const edge = this._state.edge;
        const wide = 36;
        const thick = 10;
        const vertical = this._vertical;
        const barStart = vertical ? box.y : box.x;
        const barEnd = barStart + (vertical ? box.height : box.width);
        if (along < barStart - 4 || along > barEnd + 4)
            return;
        handle.set_size(vertical ? wide : thick, vertical ? thick : wide);
        const px = vertical
            ? (edge === 'left' ? box.x + box.width + 4 : box.x - wide - 4)
            : along - thick / 2;
        const py = vertical
            ? along - thick / 2
            : (edge === 'top' ? box.y + box.height + 4 : box.y - wide - 4);
        const monitor = this._monitor;
        handle.set_position(
            Math.round(vertical ? clamp(px, monitor.x + 4, monitor.x + monitor.width - wide - 4) : px),
            Math.round(vertical ? py : clamp(py, monitor.y + 4, monitor.y + monitor.height - wide - 4)));
        handle.visible = true;
    }

    _snapAppsHandle() {
        const handle = this._editHandles?.apps;
        const view = this._appViewport;
        if (!handle || !view || this._destroyed || !this._state.editMode)
            return;
        try {
            const [ax, ay] = view.get_transformed_position();
            const [aw, ah] = view.get_transformed_size();
            if (aw <= 0 || ah <= 0)
                return;
            const box = this._box;
            if (!box)
                return;
            const atEnd = this._appsPlace === 'end';
            const along = this._vertical ? (atEnd ? ay : ay + ah) : (atEnd ? ax : ax + aw);
            const crossStart = this._vertical ? ax : ay;
            const crossEnd = crossStart + (this._vertical ? aw : ah);
            const barCross = this._vertical ? box.x : box.y;
            const barCrossEnd = barCross + (this._vertical ? box.width : box.height);
            if (crossEnd < barCross - 8 || crossStart > barCrossEnd + 8)
                return;
            this._placeAppsHandleAt(along);
        } catch {
            /* Leave the handle where the last good edge put it. */
        }
    }

    _beginGeom(event, mode) {
        if (!event || event.get_button() !== 1)
            return Clutter.EVENT_PROPAGATE;
        const [px, py] = event.get_coords();
        this._endGeom(false);
        this._geomDrag = {
            mode,
            px, py,
            axis: null,
            barBase: this._vertical ? this._box.height : this._box.width,
            thickness: this._state.thickness,
            length: this._state.length,
            margin: this._state.margin,
            dockMinLength: this._state.dockMinLength ?? 240,
            appsLength: this._state.appsLength || 0,
            appsCap: this._state.appsCap === true,
            pending: null,
        };
        if (mode === 'apps') {
            const actor = this._appsRow;
            const natural = actor ? this._iconRowSpan(actor) : 48;
            const size = this._appViewport?.get_transformed_size();
            const sections = this._sectionSpans();
            const others = sections.reduce((sum, span) => sum + span, 0) -
                this._contentSpan(this._appViewport) - this._appsLeadingSpace();
            const room = this._lengthBudget(this._state.margin) - others - 28;
            this._geomDrag.appsMax = Math.max(48, room);
            this._geomDrag.appsNatural = natural;
            const allocated = size ? size[this._vertical ? 1 : 0] : natural;
            this._geomDrag.appsBase = allocated + (this._centerApps ? Math.max(0, allocated - natural) : 0);
            const place = this._state.modules.find(item => item.id === 'apps')?.place ?? 'center';
            // A centered group's trailing edge moves half its change in length.
            this._geomDrag.appsScale = this._state.kind === 'dock' || place === 'center' ? 2 : 1;
        }
        if (this._state.autohide)
            this._slide(true, false);
        try {
            global.display.set_cursor(Meta.Cursor.MOVE);
        } catch {
            /* Cursor enums differ across Shell versions. */
        }
        this._geomWatch = global.stage.connect('captured-event', (_stage, captured) => this._onGeom(captured));
        return Clutter.EVENT_STOP;
    }

    _onGeom(event) {
        if (!event || !this._geomDrag || this._destroyed) {
            this._endGeom(false);
            return Clutter.EVENT_PROPAGATE;
        }
        if (event.type() === Clutter.EventType.KEY_PRESS && event.get_key_symbol() === Clutter.KEY_Escape) {
            this._endGeom(false);
            return Clutter.EVENT_PROPAGATE;
        }
        const moving = event.type() === Clutter.EventType.MOTION;
        const release = event.type() === Clutter.EventType.BUTTON_RELEASE && event.get_button() === 1;
        if (!moving && !release)
            return Clutter.EVENT_PROPAGATE;
        const [px, py] = event.get_coords();
        const drag = this._geomDrag;
        drag.pending = this._geomValues(drag, px - drag.px, py - drag.py);
        this._place(drag.pending);
        if (release)
            this._endGeom(true);
        return Clutter.EVENT_STOP;
    }

    _geomValues(drag, dx, dy) {
        const values = {
            thickness: drag.thickness,
            length: drag.length,
            margin: drag.margin,
            dockMinLength: drag.dockMinLength,
            appsLength: drag.appsLength,
            appsCap: drag.appsCap === true,
        };
        const edge = this._state.edge;
        if (drag.mode === 'apps') {
            const along = this._vertical ? dy : dx;
            if (!drag.moved && Math.abs(along) < 3)
                return values;
            drag.moved = true;
            // End is pinned to the far side, so its handle is the inner edge and drags the other way.
            const next = drag.appsBase + along * drag.appsScale * (this._appsPlace === 'end' ? -1 : 1);
            const fitted = Math.abs(next - drag.appsNatural) < 20;
            values.appsLength = fitted ? 0 : clamp(Math.round(next), 48, Math.min(2400, drag.appsMax));
            values.appsCap = !fitted && next < drag.appsNatural;
            return values;
        }
        if (drag.mode === 'distance') {
            const outward = edge === 'left' ? dx : edge === 'right' ? -dx : edge === 'top' ? dy : -dy;
            values.margin = clamp(Math.round(drag.margin + outward), 0, 64);
            return values;
        }
        if (!drag.axis) {
            if (Math.abs(dx) < 4 && Math.abs(dy) < 4)
                return values;
            const along = this._vertical ? Math.abs(dy) : Math.abs(dx);
            const across = this._vertical ? Math.abs(dx) : Math.abs(dy);
            drag.axis = along >= across ? 'length' : 'thickness';
        }
        if (drag.axis === 'thickness') {
            const across = edge === 'left' ? dx : edge === 'right' ? -dx : edge === 'top' ? dy : -dy;
            values.thickness = clamp(Math.round(drag.thickness + across * 2), 44, 88);
            return values;
        }
        const along = this._vertical ? dy : dx;
        if (this._state.kind === 'dock' && this._state.fitContent) {
            values.dockMinLength = clamp(Math.round(drag.barBase + along * 2),
                64, Math.min(10000, this._lengthBudget(drag.margin)));
            return values;
        }
        const budget = Math.max(1, this._lengthBudget(drag.margin));
        const next = (drag.barBase ?? budget * drag.length / 100) + along * 2;
        values.length = clamp(Math.round(next / budget * 100), 20, 100);
        return values;
    }

    _lengthBudget(margin) {
        let {width, height} = this._monitor;
        if (!this._vertical) {
            const occupied = edge => Math.max(0, ...this._state.bars.filter(bar =>
                bar.edge === edge && bar.kind !== 'dock' && !bar.margin && bar.length === 100)
                .map(bar => bar.thickness));
            width = Math.max(this._state.thickness, width - occupied('left') - occupied('right'));
        }
        return (this._vertical ? height : width) - margin * 2;
    }

    _endGeom(save) {
        const drag = this._geomDrag;
        if (this._geomWatch) {
            const watch = this._geomWatch;
            this._geomWatch = 0;
            global.stage.disconnect(watch);
        }
        this._geomDrag = null;
        if (!drag)
            return;
        try {
            global.display.set_cursor(Meta.Cursor.DEFAULT);
        } catch {
            /* Cursor enums differ across Shell versions. */
        }
        if (!save || this._destroyed) {
            if (!this._destroyed)
                this._place();
            return;
        }
        const values = drag.pending;
        if (!values)
            return;
        const patch = {};
        if (values.thickness !== drag.thickness)
            patch.thickness = values.thickness;
        if (values.length !== drag.length)
            patch.length = values.length;
        if (values.margin !== drag.margin)
            patch.margin = values.margin;
        if (values.dockMinLength !== drag.dockMinLength)
            patch.dockMinLength = values.dockMinLength;
        if (values.appsLength !== drag.appsLength || values.appsCap !== drag.appsCap) {
            patch.appsLength = values.appsLength;
            patch.appsCap = values.appsCap === true;
        }
        if (Object.keys(patch).length) {
            if ('appsLength' in patch)
                this._state.appsLength = patch.appsLength;
            if ('appsCap' in patch)
                this._state.appsCap = patch.appsCap;
            if (drag.mode === 'apps') {
                this._overlay.skipRebuild(() => patchBar(this._overlay._settings, this._index, patch));
                for (const bar of this._overlay._bars) {
                    if (bar !== this && bar._index === this._index) {
                        bar._state.appsLength = values.appsLength;
                        bar._state.appsCap = values.appsCap;
                        bar._place();
                    }
                }
            } else
                patchBar(this._overlay._settings, this._index, patch);
        }
    }

    _enableAutohide() {
        this._shown = false;
        this._slide(false, false);
        const band = 4;
        const monitor = this._monitor;
        this._trigger = new St.Widget({reactive: true, track_hover: true, style: 'background-color: transparent;'});
        let x = monitor.x;
        let y = monitor.y;
        let width = monitor.width;
        let height = monitor.height;
        if (this._state.edge === 'left')
            width = band;
        else if (this._state.edge === 'right') {
            x = monitor.x + monitor.width - band;
            width = band;
        } else if (this._state.edge === 'top')
            height = band;
        else {
            y = monitor.y + monitor.height - band;
            height = band;
        }
        this._trigger.set_position(x, y);
        this._trigger.set_size(width, height);
        this._trigger.connect('notify::hover', () => {
            if (this._trigger.hover)
                this._slide(true, true);
        });
        chrome(this._trigger, true);
        this._actor.connect('notify::hover', () => {
            if (this._actor.hover || this._popout)
                this._slide(true, true);
            else
                this._slideLater();
        });
    }

    _slide(show, animate) {
        if (this._destroyed)
            return;
        this._cancel('_hideTimer');
        this._shown = show;
        if (this._joinedAutohide) {
            this._revealTimeline?.stop();
            const from = this._revealProgress ?? 0;
            const target = show ? 1 : 0;
            const frame = this._overlay._frames.get(this._monitor.index);
            const paint = value => {
                if (this._destroyed || !this._actor?.get_stage())
                    return;
                this._revealProgress = value;
                frame?.setReveal(this._index, this._state.edge, this._vertical ? this._box.width : this._box.height, value);
                const {width, height} = this._box;
                try {
                    this._actor.set_clip(this._state.edge === 'right' ? width * (1 - value) : 0,
                        this._state.edge === 'bottom' ? height * (1 - value) : 0,
                        this._vertical ? width * value : width, this._vertical ? height : height * value);
                    this._actor.opacity = Math.round(255 * value);
                } catch {
                    return;
                }
                this._overlay.relayoutPopups(this._monitor.index);
            };
            this._actor.show();
            const duration = animate && allowsMotion(St.Settings.get(), St.ReducedMotion) ? this._state.animationDuration : 0;
            if (!duration) {
                paint(target);
                this._overlay.relayoutPopups(this._monitor.index, true);
                return;
            }
            const timeline = new Clutter.Timeline({actor: this._actor, duration});
            this._revealTimeline = timeline;
            timeline.set_progress_mode(Clutter.AnimationMode.EASE_OUT_EXPO);
            timeline.connect('new-frame', () => paint(from + (target - from) * timeline.get_progress()));
            timeline.connect('completed', () => {
                paint(target);
                this._revealTimeline = null;
                this._overlay.relayoutPopups(this._monitor.index, true);
            });
            timeline.start();
            return;
        }
        // Fold into this monitor's edge; translating offscreen spills onto a
        // neighboring display and can steal its clicks.
        const edge = this._state.edge;
        this._actor.set_pivot_point(edge === 'right' ? 1 : 0, edge === 'bottom' ? 1 : 0);
        const scaleX = this._vertical && !show ? 0 : 1;
        const scaleY = !this._vertical && !show ? 0 : 1;
        this._actor.remove_all_transitions();
        this._actor.show();
        if (!animate || !allowsMotion(St.Settings.get(), St.ReducedMotion)) {
            this._actor.set_scale(scaleX, scaleY);
            this._actor.opacity = show ? 255 : 0;
            this._overlay.relayoutPopups(this._monitor.index, true);
            return;
        }
        this._actor.ease({
            scale_x: scaleX, scale_y: scaleY, opacity: show ? 255 : 0,
            duration: 220, mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            onComplete: () => this._overlay.relayoutPopups(this._monitor.index, true),
        });
        this._overlay.relayoutPopups(this._monitor.index);
    }

    _slideLater() {
        this._later('_hideTimer', 280, () => {
            if (!this._actor.hover && !this._trigger?.hover && !this._edgeHoverActive && !this._popout && !this._shelfOpen && !this._indicatorMenuOpen)
                this._slide(false, true);
        });
    }

    _module(id, icon) {
        return moduleView(this, id)._buildModule(moduleType(id), icon);
    }

    _buildModule(id, icon) {
        if (id === 'shelf') return shelfFace(this, icon);
        if (id === 'timer') return this._panelModule(id, timerFace(this, moduleFeatures(this, id), icon), () => expandedModule(this, id));
        if (id === 'shortcuts') return this._panelModule(id, shortcutFace(this, moduleFeatures(this, id), icon), () => expandedModule(this, id));
        if (['shortcuts', 'timer', 'devices', 'input'].includes(id)) return this._panelModule(id, this._button(GROUP_ITEMS[id].icon, icon), () => expandedModule(this, id));
        if (id === 'notifications') return this._panelModule(id, this._button('preferences-system-notifications-symbolic', icon), () => buildNotificationCenter(this));
        switch (id) {
        case 'logo': {
            const mark = new St.Icon({
                icon_name: this._state.logoIcon,
                icon_size: icon,
                style: `color: ${this._theme.fg};`,
            });
            const file = logoFile(this._state.logoIcon);
            if (file?.query_exists(null))
                mark.gicon = new Gio.FileIcon({file});
            // Match an app button: padding, then the icon, then the slot the running dot uses.
            const column = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style: 'spacing: 3px;'});
            column.add_child(mark);
            column.add_child(new St.Widget({height: 3, width: 14, opacity: 0}));
            const button = new St.Button({
                reactive: true,
                can_focus: true,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
                child: column,
                style: 'padding: 5px; border-radius: 12px;',
            });
            button.accessible_name = this._state.logoAction === 'launcher' ? 'Application launcher' : 'GNOME applications and overview';
            button._activate = () => {
                if (this._state.logoAction === 'overview') Main.overview.toggle();
                else if (this._state.logoAction === 'apps') Main.overview.showApps();
                else this._overlay.toggleLauncher(this);
            };
            return button;
        }
        case 'workspaces':
            return this._workspaces(icon);
        case 'apps':
            return this._apps(icon);
        case 'window':
            return this._window(icon);
        case 'weather':
            return this._panelModule('weather', this._weatherFace(icon), () => weatherWidget(this));
        case 'date':
            return this._date();
        case 'clock':
            return this._clock();
        case 'output':
        case 'bluetooth':
        case 'brightness':
            return this._panelModule(id, this._button(GROUP_ITEMS[id].icon, icon), () => this._groupItem({module: id, view: 'full'}));
        case 'volume':
        case 'network':
        case 'battery':
            return this._statusGroup(icon, [id]);
        case 'power':
            return this._panelModule('power', this._button('system-shutdown-symbolic', icon), () => this._session());
        case 'dashboard':
            return this._panelModule('dashboard', this._button('view-paged-symbolic', icon), () => this._dashboard());
        case 'screenshot': {
            const button = this._button('camera-photo-symbolic', icon);
            const sync = () => {
                const face = screenshotFace(this._theme.fg);
                button.child.icon_name = face.icon;
                button.child.style = `color: ${face.color};`;
                button.accessible_name = face.name;
            };
            watchScreenshotRecording(button, sync);
            sync();
            const run = () => {
                this._close();
                activateScreenshot().catch(error => console.warn(`Bezel: screenshot UI unavailable: ${error.message}`));
            };
            button._activate = run;
            button._recordingStop = run;
            this._hoverDrawer('screenshot', button, () => moduleSection(this, 'screenshot'), this._hoverFor('screenshot'));
            return button;
        }
        case 'dnd':
            return this._switch('dnd', icon, 'notifications-disabled-symbolic', 'preferences-system-notifications-symbolic', 'Do Not Disturb', dndControl());
        case 'nightlight':
            return this._switch('nightlight', icon, 'night-light-symbolic', 'night-light-disabled-symbolic', 'Night Light', nightLightControl());
        case 'dark':
            return this._switch('dark', icon, 'weather-clear-night-symbolic', 'weather-clear-symbolic', 'Dark style', darkStyleControl());
        case 'performance':
            return this._panelModule('performance', buildValueButton(this, 'performance', 'power-profile-balanced-symbolic', icon, 'Performance'), () => expandedModule(this, 'performance'));
        case 'vpn':
            return this._panelModule('vpn', buildValueButton(this, 'vpn', 'network-vpn-symbolic', icon, 'VPN'), () => vpnMenu(this));
        case 'settings':
            return this._panelModule('settings', this._button('preferences-system-symbolic', icon), () => settingsMenu(this));
        case 'media':
            return this._panelModule('media', buildMediaFace(this, icon), () => this._mediaCard(true, 72));
        case 'microphone':
            return this._panelModule('microphone', buildMicFace(this, icon), () => this._groupItem({module: 'microphone'}));
        case 'clipboard':
            return this._panelModule('clipboard', this._button('edit-paste-symbolic', icon), () => buildClipboardPanel(this));
        case 'keyboard':
            return buildKeyboardFace(this, icon);
        case 'awake':
            return buildAwakeFace(this, icon);
        case 'indicators':
            return this._indicatorsFace();
        default:
            return isSpacer(id) ? this._spacer(id) : null;
        }
    }

    _indicatorsFace() {
        // The module stays in the layout so its place is remembered. While the
        // switch is off, leave the icons on the GNOME panel and take no slot.
        if (!this._overlay._settings.get_boolean('panel-indicators'))
            return null;
        const box = new St.BoxLayout({
            orientation: this._content.orientation,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            style: `spacing: ${this._overlay._settings.get_int('indicator-spacing')}px;`,
        });
        this._indicatorSlot = box;
        return box;
    }

    _sideways(color, fontSize) {
        const area = new St.DrawingArea({
            reactive: false,
            clip_to_allocation: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        area._bezelVertical = true;
        area._bezelFont = fontSize;
        area._bezelColor = color;
        area._bezelString = '';
        area.connect('repaint', () => this._paintSideways(area));
        this._fitSideways(area, '');
        return area;
    }

    _fitSideways(area, text) {
        if (!area?._bezelVertical)
            return;
        const next = text ?? '';
        const font = area._bezelFont || 13;
        const fitted = next ? area.height > 0 : area.height === 0;
        if (area._bezelString === next && area._bezelFit === font && fitted)
            return;
        area._bezelString = next;
        area._bezelFit = font;
        if (!next) {
            area._bezelLimit = false;
            area.width = font + 4;
            area.height = 0;
            area.queue_repaint();
            return;
        }
        const probe = new St.Label({
            text: next,
            style: `font-size: ${font}px; font-weight: 600;`,
        });
        probe.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        const [, natW] = probe.get_preferred_width(-1);
        const [, natH] = probe.get_preferred_height(-1);
        probe.destroy();
        const limit = Math.max(font * 7, 128);
        const pixels = Math.ceil(natW || next.length * font * 0.62);
        const length = Math.max(Math.ceil(natH) + 2, Math.min(pixels, limit));
        const thick = Math.max(Math.ceil(natH) + 4, font + 4);
        area._bezelLimit = pixels > limit + 1;
        area.width = thick;
        area.height = length;
        area.queue_repaint();
    }

    _paintSideways(area) {
        const cr = area.get_context();
        const text = area._bezelString || '';
        if (!text) {
            cr.$dispose();
            return;
        }
        try {
            const [sw, sh] = area.get_surface_size();
            const width = Math.max(1, area.width || 1);
            const height = Math.max(1, area.height || 1);
            if (sw > 0 && sh > 0 && (Math.abs(sw - width) > 1 || Math.abs(sh - height) > 1))
                cr.scale(sw / width, sh / height);
            const layout = PangoCairo.create_layout(cr);
            const font = area._bezelFont || 13;
            const description = new Pango.FontDescription();
            description.set_family('Sans');
            description.set_absolute_size(font * Pango.SCALE);
            description.set_weight(Pango.Weight.SEMIBOLD);
            layout.set_font_description(description);
            layout.set_text(text, -1);
            if (area._bezelLimit) {
                layout.set_width(Math.max(1, height - 2) * Pango.SCALE);
                layout.set_ellipsize(Pango.EllipsizeMode.END);
            } else {
                layout.set_ellipsize(Pango.EllipsizeMode.NONE);
            }
            const hex = `${area._bezelColor || '#cdd6f4'}`.replace('#', '');
            const rgb = [0, 2, 4].map(index => parseInt(hex.slice(index, index + 2), 16) / 255);
            cr.setSourceRGB(rgb[0] || 1, rgb[1] || 1, rgb[2] || 1);
            const [, textHeight] = layout.get_pixel_size();
            const glyph = textHeight || font;
            const offset = Math.max(0, (width - glyph) / 2);
            // Start the string at the icon and run downward, so the slot
            // is only as long as the text and there is no gap above it.
            cr.translate(offset + glyph, 0);
            cr.rotate(Math.PI / 2);
            PangoCairo.show_layout(cr, layout);
        } finally {
            cr.$dispose();
        }
    }

    _hoverFor(id) {
        const module = this._state.modules.find(item => item.id === id);
        const group = module?.group ? barGroups(this._state).find(item => item.id === module.group) : null;
        return hoverEnabled(module, group, this._overlay._settings);
    }

    _panelModule(id, button, build) {
        if (!button)
            return null;
        button._activate = () => this._toggle(id, button, build);
        this._hoverDrawer(id, button, build, this._hoverFor(id));
        return button;
    }

    _weatherFace(size) {
        const look = moduleLook(this._state.modules.find(item => item.id === 'weather'), this._state);
        const row = new St.BoxLayout({
            orientation: this._vertical ? Clutter.Orientation.VERTICAL : Clutter.Orientation.HORIZONTAL,
            style: 'spacing: 4px;', x_align: Clutter.ActorAlign.CENTER,
        });
        const icon = new St.Icon({icon_size: size, style: `color: ${this._theme.accent};`});
        const text = label(this._theme.fg, Math.max(11, Math.round(size * 0.55)));
        if (look.icon)
            row.add_child(icon);
        if (look.value)
            row.add_child(text);
        const button = new St.Button({reactive: true, child: row, x_align: Clutter.ActorAlign.CENTER});
        const unsubscribe = this._overlay.weather.subscribe(() => {
            const summary = this._overlay.weather.summary;
            icon.icon_name = summary.icon;
            text.text = railTemp(summary.compact);
            button.accessible_name = summary.text;
            if (this._box) this._place();
        });
        button.connect('destroy', unsubscribe);
        return button;
    }

    _switch(id, icon, onIcon, offIcon, name, control) {
        if (!control)
            return null;
        const button = this._button(offIcon, icon);
        bindToggle(button, {onIcon, offIcon, name, ...control});
        this._hoverDrawer(id, button, () => moduleSection(this, id), this._hoverFor(id));
        return button;
    }

    _spacer(id) {
        const item = this._state.modules.find(module => module.id === id);
        const along = Math.max(8, item?.size || this._state.iconSize);
        const across = this._state.iconSize;
        return new St.Widget({
            reactive: this._state.editMode,
            can_focus: this._state.editMode,
            accessible_name: 'Empty space',
            width: this._vertical ? across : along,
            height: this._vertical ? along : across,
            style: this._state.editMode
                ? `border: 1px dashed ${this._theme.muted}; border-radius: 8px;`
                : 'background-color: transparent;',
        });
    }

    _cluster(members, icon) {
        const ids = members.map(item => item.id);
        const group = barGroups(this._state).find(group => group.id === members[0]?.group);
        if (group?.popout) return this._customGroupFace(members, group, icon);
        if (group && ids.some(id => id !== moduleType(id) || ['output', 'bluetooth', 'brightness'].includes(id)))
            return this._customGroupFace(members, {...group, popout: groupLayoutPreset('stacked', ids)}, icon);
        if (ids.length === 1) {
            const face = this._module(ids[0], icon);
            if (face)
                this._wire(face);
            return face;
        }
        const panel = () => this._groupPanel(ids);
        const popoutId = this._groupPopoutId(ids);
        const hover = ids.some(id => this._hoverFor(id));
        const faces = [];
        for (const id of ids) {
            const face = this._groupFace(id, ids, icon);
            if (!face)
                continue;
            if (!isSpacer(id) && !['workspaces', 'logo'].includes(id)) {
                face._activate = () => this._toggle(popoutId, face, panel);
                this._hoverDrawer(popoutId, face, panel, hover);
            }
            faces.push(face);
        }
        if (faces.length === 1)
            return faces[0];
        const box = new St.BoxLayout({
            orientation: this._content.orientation,
            x_align: Clutter.ActorAlign.CENTER, style: 'spacing: 6px;',
        });
        for (const face of faces) {
            this._wire(face);
            box.add_child(face);
        }
        return box;
    }

    _customGroupFace(members, group, icon) {
        const box = new St.BoxLayout({orientation: this._content.orientation, style: 'spacing: 6px;',
            x_align: Clutter.ActorAlign.CENTER});
        const ids = group.face === 'single' ? [null] : members.map(item => item.id);
        for (const id of ids) {
            const direct = id && (group.clicks?.[id] === 'direct' || ['apps', 'workspaces'].includes(moduleType(id)));
            const face = direct ? this._module(id, icon) : id && ['clock', 'date', 'weather', 'volume', 'network', 'battery'].includes(id)
                ? this._groupFace(id, [id], icon) : id ? this._groupFace(id, [id], icon) : this._button(group.icon || 'view-grid-symbolic', icon);
            if (!face) continue;
            if (!direct) {
                const panel = () => buildGroupPopout(this, group, group.clicks?.[id] === 'tab' ? id : null);
                face._activate = () => this._toggle(`group:${group.id}`, face, panel);
                face.accessible_name = id ? GROUP_ITEMS[moduleType(id)]?.title || id : group.name;
                this._hoverDrawer(`group:${group.id}`, face, panel, typeof group.hover === 'boolean' ? group.hover : members.some(member => this._hoverFor(member.id)));
            }
            this._wire(face); box.add_child(face);
        }
        return box;
    }

    _groupItemAvailable(id) {
        if (['output', 'network', 'bluetooth'].includes(id)) return deviceAvailable(id);
        if (id === 'brightness') return this._overlay.services.hasBrightness;
        if (id === 'battery') return this._overlay.services.batteryInfo.present;
        return true;
    }

    _notificationsAction() {
        return this._action('Notifications', 'preferences-system-notifications-symbolic', () => this._open('notifications', this._actor, () => buildNotificationCenter(this)));
    }

    _groupItem(item) {
        if (item.instance && item.instance !== this._moduleInstance) return moduleView(this, item.instance)._groupItem({...item, instance: null});
        const id = item.module;
        const features = moduleFeatures(this, id, item.options);
        if (id === 'shelf') return shelfPanel(this, features);
        if (['shortcuts', 'timer', 'devices', 'input', 'performance'].includes(id)) return expandedModule(this, id, item.options);
        if (id === 'notifications') return features.embedded ? buildNotificationCenter(this, true) : this._notificationsAction();
        const services = this._overlay.services;
        const box = () => new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style: 'spacing: 8px;', x_expand: true});
        if (['output', 'network', 'bluetooth'].includes(id)) {
            const root = box();
            if (id === 'network' && !item.groupHeader) {
                const line = this._networkPopoutLine(item.options);
                if (line) root.add_child(line);
            }
            root.add_child(buildDevicePanel(this, id, item.options));
            return root;
        }
        if (id === 'logo' || id === 'apps') return this._action('Applications', GROUP_ITEMS.logo.icon, () => this._overlay.toggleLauncher(this));
        if (id === 'dashboard') return this._action('Dashboard', GROUP_ITEMS.dashboard.icon, () => this._open('dashboard', this._actor, () => this._dashboard()));
        if (item.view === 'action' && id === 'power') return this._action('Power menu', GROUP_ITEMS.power.icon, () => this._open('power', this._actor, () => this._session()));
        if (item.view === 'action' && id === 'settings') return this._action('Settings', GROUP_ITEMS.settings.icon, () => this._overlay.openSettings());
        if (id === 'volume' || id === 'brightness') {
            const root = buildLevelControl(this, id, true, item.options);
            if (id === 'volume' && features.showOutputDevices) root.add_child(outputDevices(this));
            return root;
        }
        if (id === 'clock' || id === 'date') {
            const root = box();
            const value = label(this._theme.fg, id === 'clock' ? 26 : 16);
            root.add_child(value);
            const clockBar = readBars(this._overlay._settings)[this._index];
            const desktopClock = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
            const twelve = barTimeFormat(clockBar, desktopClock.get_string('clock-format')) === '12h';
            const sharedClock = clockBar?.modules.find(module => module.id === (this._moduleInstance || 'clock'));
            const seconds = (sharedClock ? sharedClock.showSeconds : item.options?.showSeconds) ?? clockBar?.clockSeconds === true;
            const update = () => { value.text = GLib.DateTime.new_now_local().format(id === 'date' ? DATE_FORMATS[barDateFormat(clockBar, this._overlay._settings)].format : timePattern(twelve, seconds)) || ''; return GLib.SOURCE_CONTINUE; };
            update();
            const timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, update);
            this._popupCleanups.push(() => GLib.source_remove(timer));
            return root;
        }
        if (id === 'calendar') return this._monthGrid(features);
        if (id === 'weather') return weatherWidget(this, features);
        if (id === 'power') return this._session(features);
        if (id === 'media') return this._mediaCard(true, 72, features);
        if (id === 'microphone') { const root = buildMicPanel(this, item.options); if (features.showInputDevices) root.add_child(inputDevices(this)); return root; }
        if (id === 'clipboard') return buildClipboardPanel(this);
        if (id === 'keyboard') return buildKeyboardPanel(this);
        if (id === 'awake') {
            const toggle = new St.Button({can_focus: true, style_class: 'bezel-action'});
            this._popupCleanups.push(services.subscribe(() => { toggle.label = `Keep awake · ${services.awake ? 'On' : 'Off'}`; }));
            toggle.connect('clicked', () => services.setAwake(!services.awake)); return toggle;
        }
        if (id === 'battery') {
            const value = label(this._theme.fg, 14, services.batteryInfo.text);
            this._popupCleanups.push(services.subscribe(() => { value.text = services.batteryInfo.text; })); return value;
        }
        if (id === 'window') return label(this._theme.fg, 14, global.display.focus_window?.get_title() || 'No focused window');
        if (id === 'workspaces') {
            const root = box(); const manager = global.workspace_manager;
            for (let i = 0; i < manager.n_workspaces; i++) root.add_child(this._action(`Workspace ${i + 1}`, GROUP_ITEMS.workspaces.icon, () => manager.get_workspace_by_index(i)?.activate(global.get_current_time())));
            return root;
        }
        return moduleSection(this, id);
    }

    _groupFace(id, ids, icon) {
        if (id !== moduleType(id)) return this._module(id, icon);
        if (['clock', 'date', 'weather'].includes(id)) {
            if (id !== ids.find(item => ['clock', 'date', 'weather'].includes(item)))
                return null;
            const column = new St.BoxLayout({
                orientation: this._vertical ? Clutter.Orientation.VERTICAL : Clutter.Orientation.HORIZONTAL,
                x_align: Clutter.ActorAlign.CENTER, style: 'spacing: 4px;',
            });
            const button = new St.Button({reactive: true, child: column, x_align: Clutter.ActorAlign.CENTER});
            this._fillClock(column, button, ids);
            return button;
        }
        if (['volume', 'network', 'battery'].includes(id)) {
            if (id !== ids.find(item => ['volume', 'network', 'battery'].includes(item)))
                return null;
            const row = new St.BoxLayout({orientation: this._content.orientation, style: 'spacing: 10px;'});
            const button = new St.Button({child: row, track_hover: true, accessible_name: 'Quick controls'});
            this._fillStatusIcons(row, button, ids.filter(item => ['volume', 'network', 'battery'].includes(item)), icon);
            button.connect('scroll-event', (_actor, event) => {
                this._overlay.services.setVolume(this._overlay.services.volume - scrollStep(event) * 0.05);
                return Clutter.EVENT_STOP;
            });
            return button;
        }
        if (id === 'power')
            return this._button('system-shutdown-symbolic', icon);
        if (id === 'dashboard')
            return this._button('view-paged-symbolic', icon);
        return this._module(id, icon);
    }

    _groupPopoutId(ids) {
        if (ids.some(id => id === 'clock' || id === 'date'))
            return 'clock';
        if (ids.includes('dashboard') && ids.length === 1)
            return 'dashboard';
        if (ids.some(id => ['volume', 'network', 'battery'].includes(id)))
            return 'status';
        if (ids.includes('power'))
            return 'power';
        if (ids.includes('dashboard'))
            return 'dashboard';
        return ids[0];
    }

    _groupPanel(ids) {
        const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style: 'spacing: 14px;'});
        if (ids.some(id => id === 'clock' || id === 'date'))
            box.add_child(this._calendar(ids));
        if (ids.some(id => ['volume', 'network', 'battery'].includes(id))) {
            const layout = sliderLayout(this._state.modules.find(item => item.id === 'volume'), this._overlay._settings);
            if (layout === 'drawer')
                box.add_child(this._statusPanel());
            else {
                if (ids.includes('network')) {
                    const line = this._networkPopoutLine();
                    if (line)
                        box.add_child(line);
                }
                box.add_child(layout === 'stack' ? buildStacked(this) : buildOsd(this));
                box.add_child(buildDeviceControls(this));
            }
        }
        if (ids.includes('power'))
            box.add_child(this._session());
        if (ids.includes('weather') && !ids.some(id => id === 'clock' || id === 'date'))
            box.add_child(weatherWidget(this));
        if (ids.includes('notifications') && !ids.some(id => id === 'clock' || id === 'date')) box.add_child(this._groupItem({module: 'notifications'}));
        if (ids.includes('media'))
            box.add_child(this._mediaCard(true, 72));
        if (ids.includes('microphone'))
            box.add_child(this._groupItem({module: 'microphone'}));
        if (ids.includes('clipboard'))
            box.add_child(buildClipboardPanel(this));
        if (ids.includes('keyboard'))
            box.add_child(buildKeyboardPanel(this));
        if (ids.includes('dashboard'))
            box.add_child(this._dashboard());
        for (const id of ['shortcuts', 'timer', 'devices', 'input']) if (ids.includes(id)) box.add_child(expandedModule(this, id));
        if (ids.includes('shelf')) box.add_child(shelfPanel(this));
        if (ids.includes('performance')) box.add_child(expandedModule(this, 'performance'));
        for (const id of ['screenshot', 'dnd', 'nightlight', 'dark', 'vpn', 'settings']) {
            if (ids.includes(id)) {
                const section = moduleSection(this, id);
                if (section)
                    box.add_child(section);
            }
        }
        return box;
    }

    syncRecordingStop(show, place = 'end') {
        if (!show || !this._actor) {
            this._removeRecordingStop();
            return;
        }
        if (this._recordingStopButton)
            return;
        const zone = this._zones?.[place];
        const button = zone && this._module('screenshot', this._state.iconSize);
        if (!button)
            return;
        this._wire(button);
        zone.add_child(button);
        zone.visible = true;
        zone._bezelEdge = place;
        if (this._state.kind === 'dock' && this._dockContent && zone.get_parent() !== this._dockContent)
            this._dockContent.add_child(zone);
        const cell = zone.get_parent();
        if (cell)
            cell.visible = true;
        this._recordingStopButton = button;
        this._place();
    }

    _removeRecordingStop() {
        const button = this._recordingStopButton;
        if (!button)
            return;
        const zone = button.get_parent();
        if (this._anchor === button)
            this._close();
        this._recordingStopButton = null;
        button.destroy();
        if (!zone || !this._actor)
            return;
        if (zone.get_n_children() === 0) {
            if (this._state.kind === 'dock' && zone.get_parent() === this._dockContent)
                this._dockContent.remove_child(zone);
            if (this._emptyPills?.has('end'))
                zone.visible = false;
        }
        this._place();
    }

    _button(iconName, size) {
        return new St.Button({
            reactive: true,
            can_focus: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({
                icon_name: iconName,
                icon_size: size,
                style: `color: ${this._theme.fg};`,
            }),
        });
    }

    _workspaces(_size) {
        const box = new St.BoxLayout({
            orientation: this._content.orientation,
            x_align: Clutter.ActorAlign.CENTER,
            style: 'spacing: 4px;',
        });
        const manager = global.workspace_manager;
        const style = this._state.modules.find(item => item.id === 'workspaces')?.workspaceStyle || 'pills';
        const paint = () => {
            box.destroy_all_children();
            const active = manager.get_active_workspace_index();
            for (let i = 0; i < manager.get_n_workspaces(); i++) {
                const selected = i === active;
                const workspace = manager.get_workspace_by_index(i);
                let child;
                if (style === 'numbers')
                    child = label(selected ? this._theme.accent : this._theme.muted, 13, `${i + 1}`);
                else if (style === 'icons') {
                    const win = workspace?.list_windows().find(item => !item.skip_taskbar && item.has_focus?.())
                        ?? workspace?.list_windows().find(item => !item.skip_taskbar);
                    const app = win ? Shell.WindowTracker.get_default().get_window_app(win) : null;
                    child = app ? app.create_icon_texture(this._state.iconSize) : label(this._theme.muted, 13, `${i + 1}`);
                    if (!selected && child.opacity !== undefined)
                        child.opacity = 160;
                } else
                    child = new St.Widget({
                        width: !this._vertical && selected ? 22 : 8,
                        height: this._vertical && selected ? 22 : 8,
                        style: `background-color: ${selected ? this._theme.accent : this._theme.muted}; border-radius: 99px;`,
                    });
                const button = new St.Button({
                    can_focus: true, style_class: 'bezel-workspace',
                    accessible_name: `Workspace ${i + 1}${selected ? ', active' : ''}`,
                    child,
                });
                button.connect('clicked', () => workspace?.activate(global.get_current_time()));
                box.add_child(button);
            }
        };
        paint();
        box.connect('scroll-event', (_actor, event) => {
            const step = scrollStep(event);
            if (step) {
                const index = clamp(manager.get_active_workspace_index() + step, 0, manager.get_n_workspaces() - 1);
                manager.get_workspace_by_index(index).activate(global.get_current_time());
            }
            return Clutter.EVENT_STOP;
        });
        this._signals.push([manager, manager.connect('notify::n-workspaces', paint)]);
        this._signals.push([manager, manager.connect('active-workspace-changed', paint)]);
        return box;
    }

    _window(size) {
        const look = moduleLook(this._state.modules.find(item => item.id === 'window'), this._state);
        const row = new St.BoxLayout({
            orientation: this._vertical ? Clutter.Orientation.VERTICAL : Clutter.Orientation.HORIZONTAL,
            style: 'spacing: 6px;', x_align: Clutter.ActorAlign.CENTER,
        });
        const icon = new St.Icon({
            icon_name: 'window-symbolic',
            icon_size: size,
            style: `color: ${this._theme.fg};`,
        });
        const title = !look.value ? null : this._vertical ? this._sideways(this._theme.fg, 13) : label(this._theme.fg, 13);
        if (title && !this._vertical) {
            title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            title.width = 280;
        }
        if (look.icon)
            row.add_child(icon);
        if (title)
            row.add_child(title);
        const button = new St.Button({
            reactive: true,
            child: row,
            x_align: Clutter.ActorAlign.CENTER,
        });
        const paint = () => {
            const win = global.display.focus_window;
            const app = win ? Shell.WindowTracker.get_default().get_window_app(win) : null;
            icon.gicon = app?.get_app_info()?.get_icon() ?? null;
            const text = win?.get_title() ?? '';
            if (title?._bezelVertical)
                this._fitSideways(title, text);
            else if (title)
                title.text = text;
            button.accessible_name = win?.get_title() ?? 'Focused app';
            button.visible = Boolean(win);
        };
        paint();
        this._signals.push([global.display, global.display.connect('notify::focus-window', paint)]);
        button._activate = () => global.display.focus_window?.activate(global.get_current_time());
        button.connect('button-press-event', (_actor, event) => {
            if (event.get_button() !== 3)
                return Clutter.EVENT_PROPAGATE;
            const win = global.display.focus_window;
            const app = win ? Shell.WindowTracker.get_default().get_window_app(win) : null;
            if (app?.get_id())
                this._open(`app:${app.get_id()}`, button, () => this._appMenu(`app:${app.get_id()}`, app));
            return Clutter.EVENT_STOP;
        });
        this._hoverDrawer('window', button, () => {
            const win = global.display.focus_window;
            const app = win ? Shell.WindowTracker.get_default().get_window_app(win) : null;
            return app?.get_id() ? this._appMenu(`app:${app.get_id()}`, app) : label(this._theme.muted, 13, 'No focused window');
        }, this._hoverFor('window'));
        return button;
    }

    _apps(size) {
        const box = new St.BoxLayout({
            orientation: this._content.orientation,
            reactive: false,
            x_expand: false,
            y_expand: false,
            x_align: this._vertical ? Clutter.ActorAlign.CENTER : Clutter.ActorAlign.START,
            y_align: this._vertical ? Clutter.ActorAlign.START : Clutter.ActorAlign.CENTER,
            style: `spacing: ${this._state.appSpacing}px;`,
        });
        box._bezelApps = true;
        this._appsRow = box;
        const system = Shell.AppSystem.get_default();
        const refresh = () => {
            if (this._popoutId?.startsWith('app:'))
                this._close();
            box.destroy_all_children();
            const ids = [...this._state.pinned];
            if (this._state.runningApps) {
                for (const app of system.get_running()) {
                    if (app.get_id() && !ids.includes(`app:${app.get_id()}`))
                        ids.push(`app:${app.get_id()}`);
                }
            }
            for (const id of ids) {
                const button = this._app(id, size);
                this._wire(button);
                box.add_child(button);
                button._bezelAppId = id;
                this._dragItem(button, () => box.get_children(), ordered => {
                    const bars = readState(this._overlay._settings).bars;
                    const pinned = bars[this._index].pinned;
                    bars[this._index].pinned = ordered.map(item => item._bezelAppId)
                        .filter(appId => pinned.includes(appId) || appId === id);
                    saveBars(this._overlay._settings, bars);
                });
            }
            if (this._box)
                this._place();
        };
        refresh();
        this._signals.push([system, system.connect('app-state-changed', refresh)]);
        return box;
    }

    _app(id, size) {
        const app = Shell.AppSystem.get_default().lookup_app(id.slice(4));
        const content = new St.Widget({width: size, height: size, layout_manager: new Clutter.BinLayout()});
        const icon = app ? app.create_icon_texture(size) : new St.Icon({icon_name: 'application-x-executable-symbolic', icon_size: size});
        content.add_child(icon);
        icon.set_pivot_point(.5, .5);
        const indicator = new St.Widget({height: 3, width: this._state.appIndicator === 'dot' ? 3 : 14, x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.END, x_expand: true, y_expand: true, translation_y: 5,
            style: `background-color: ${this._theme.accent}; border-radius: 3px;`});
        indicator.visible = this._state.appIndicator !== 'none' && Boolean(app?.get_windows().length);
        content.add_child(indicator);
        content._bezelRunningIndicator = indicator;
        const button = new St.Button({child: content, track_hover: true, x_align: Clutter.ActorAlign.CENTER,
            style: 'padding: 5px; border-radius: 12px;',
            accessible_name: app?.get_name() ?? id.slice(4)});
        const updateFeedback = () => {
            const focused = Shell.WindowTracker.get_default().focus_app === app;
            const highlighted = (button.hover && ['highlight', 'both'].includes(this._state.appHover)) || (focused && ['background', 'both'].includes(this._state.appFocus));
            button.style = `padding: 5px; border-radius: 12px; background-color: ${highlighted ? this._theme.surface : 'transparent'};`;
            indicator.visible = (focused && ['line', 'both'].includes(this._state.appFocus)) || (this._state.appIndicator !== 'none' && Boolean(app?.get_windows().length));
            indicator.width = focused && ['line', 'both'].includes(this._state.appFocus) ? size * .7 : this._state.appIndicator === 'dot' ? 3 : 14;
            indicator.opacity = focused ? 255 : 130;
            const lift = button.hover && !this._state.editMode && ['lift', 'both'].includes(this._state.appHover) ? 4 : 0;
            icon.ease({translation_x: this._state.edge === 'left' ? lift : this._state.edge === 'right' ? -lift : 0,
                translation_y: this._state.edge === 'top' ? lift : this._state.edge === 'bottom' ? -lift : 0,
                duration: allowsMotion(St.Settings.get(), St.ReducedMotion) ? 140 : 0, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        };
        const tracker = Shell.WindowTracker.get_default();
        const focusSignal = tracker.connect('notify::focus-app', updateFeedback);
        button.connect('destroy', () => tracker.disconnect(focusSignal));
        button.connect('notify::hover', updateFeedback);
        button.connect('notify::pressed', () => {
            if (!this._state.appPress || !allowsMotion(St.Settings.get(), St.ReducedMotion)) return;
            icon.ease({scale_x: button.pressed ? .88 : 1, scale_y: button.pressed ? .88 : 1,
                duration: 100, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        });
        updateFeedback();
        const updateGeometry = this._overlay.appIconGeometry.add(button, app, this);
        const click = appClickHandler(app, this._state.appClick, () => this._toggle(id, button, () => this._appMenu(id, app)));
        button._activate = () => {
            updateGeometry();
            if (global.get_pointer()[2] & Clutter.ModifierType.CONTROL_MASK) activateApp(app, true);
            else click();
        };
        button.connect('button-press-event', (_actor, event) => {
            if (event.get_button() === 2) {
                updateGeometry();
                activateApp(app, true);
                return Clutter.EVENT_STOP;
            }
            if (event.get_button() !== 3)
                return Clutter.EVENT_PROPAGATE;
            this._open(id, button, () => this._appMenu(id, app));
            return Clutter.EVENT_STOP;
        });
        button.connect('notify::hover', () => {
            this._cancel('_appHover');
            if (button.hover && !this._state.editMode && this._hoverFor('apps'))
                this._later('_appHover', this._state.hoverDelay + 150, () => this._open(id, button, () => this._appMenu(id, app), null, true));
            else
                this._closeSoon();
        });
        return button;
    }

    _appMenu(id, app) {
        const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style: 'spacing: 10px;'});
        box.add_child(label(this._theme.fg, 17, app?.get_name() ?? 'Application unavailable'));
        const windows = app?.get_windows() ?? [];
        const source = windows[0]?.get_compositor_private();
        if (source && source.width > 0 && source.height > 0) {
            const width = Math.min(270, source.width);
            const height = Math.min(170, width * source.height / source.width);
            const preview = new Clutter.Clone({source, width, height});
            const wrap = new St.Widget({width, height, clip_to_allocation: true});
            wrap.add_child(preview);
            box.add_child(wrap);
        }
        const pinned = this._state.pinned.includes(id);
        box.add_child(this._action(pinned ? 'Unpin from this bar' : 'Pin to this bar', 'view-pin-symbolic', () => {
            if (pinned)
                this._overlay.unpin(id, this._index);
            else
                this._overlay.pin(id.slice(4), this._index);
        }));
        if (app)
            box.add_child(this._action('New window', 'window-new-symbolic', () => app.open_new_window(-1)));
        for (const win of windows)
            box.add_child(this._action(win.get_title() || 'Window', 'focus-windows-symbolic', () => Main.activateWindow(win)));
        return box;
    }

    _clock() {
        return this._clockButton(['clock']);
    }

    _date() {
        return this._clockButton(['date']);
    }

    _clockButton(ids) {
        const column = new St.BoxLayout({
            orientation: this._vertical ? Clutter.Orientation.VERTICAL : Clutter.Orientation.HORIZONTAL,
            x_align: Clutter.ActorAlign.CENTER, style: 'spacing: 4px;',
        });
        const button = new St.Button({reactive: true, child: column, x_align: Clutter.ActorAlign.CENTER});
        this._fillClock(column, button, ids);
        const panel = () => this._groupPanel(ids);
        button._activate = () => this._toggle('clock', button, panel);
        this._hoverDrawer('clock', button, panel, this._hoverFor(ids.includes('date') && !ids.includes('clock') ? 'date' : 'clock'));
        return button;
    }

    _fillClock(column, button, ids) {
        const time = label(this._theme.accent, 16);
        const minute = label(this._theme.accent, 16);
        const ampm = label(this._theme.muted, 10);
        const datePrimary = label(this._theme.accent, this._vertical ? 13 : 14);
        const dateSecondary = label(this._theme.muted, 11);
        const showWeather = ids.includes('weather');
        const weatherIcon = new St.Icon({icon_size: 16, style: `color: ${this._theme.accent};`});
        const temperature = label(this._theme.fg, this._vertical ? 11 : 12);
        temperature._bezelRailTemp = true;
        temperature.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        const pieces = {
            clock: [time, minute, ampm],
            date: [datePrimary, dateSecondary],
            weather: [weatherIcon, temperature],
        };
        for (const id of ids)
            for (const actor of pieces[id] ?? [])
                column.add_child(actor);
        const names = {clock: '', date: ''};
        const clockSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        const paint = () => {
            const bar = readBars(this._overlay._settings)[this._index];
            const twelve = barTimeFormat(bar, clockSettings.get_string('clock-format')) === '12h';
            const seconds = bar?.modules.find(item => item.id === (this._moduleInstance || 'clock'))?.showSeconds ?? bar?.clockSeconds === true;
            if (ids.includes('clock')) {
                const shown = (GLib.DateTime.new_now_local().format(timePattern(twelve, seconds)) ?? '').replace(/^0/, '');
                const hour = (GLib.DateTime.new_now_local().format(twelve ? '%I' : '%H') ?? '').replace(/^0/, '');
                time.text = this._vertical ? hour : shown;
                minute.text = seconds ? `${now('%M')}:${now('%S')}` : now('%M');
                minute.visible = this._vertical;
                ampm.text = twelve ? now('%p').toLowerCase() : '';
                ampm.visible = twelve && this._vertical;
                names.clock = shown;
            }
            if (ids.includes('date')) {
                const key = barDateFormat(bar, this._overlay._settings);
                const spec = DATE_FORMATS[key]?.format ?? DATE_FORMATS.medium.format;
                const text = (GLib.DateTime.new_now_local().format(spec) ?? '').replace(/\s+/g, ' ').trim();
                if (this._vertical) {
                    const parts = text.split(' ');
                    datePrimary.text = parts[0] ?? '';
                    dateSecondary.text = parts.slice(1).join(' ');
                    dateSecondary.visible = Boolean(dateSecondary.text);
                } else {
                    datePrimary.text = text;
                    dateSecondary.visible = false;
                }
                names.date = text;
            }
            button.accessible_name = [names.clock, names.date].filter(Boolean).join(' · ') || 'Clock';
            if (this._box) this._place();
        };
        paint();
        if (ids.includes('clock'))
            this._signals.push([clockSettings, clockSettings.connect('changed::clock-format', paint)]);
        if (ids.includes('date') && this._overlay._settings.settings_schema.has_key('date-format'))
            this._signals.push([this._overlay._settings, this._overlay._settings.connect('changed::date-format', paint)]);
        this._timers.add(GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            paint();
            return GLib.SOURCE_CONTINUE;
        }));
        if (showWeather) {
            const look = moduleLook(this._state.modules.find(item => item.id === 'weather'), this._state);
            weatherIcon.visible = look.icon;
            temperature.visible = look.value;
            const unsubscribe = this._overlay.weather.subscribe(() => {
                const weather = this._overlay.weather.summary;
                weatherIcon.icon_name = weather.icon;
                temperature.text = this._vertical ? railTemp(weather.compact) : weather.compact;
                if (this._box) this._place();
            });
            button.connect('destroy', unsubscribe);
        }
    }

    _fillStatusIcons(box, button, ids, size) {
        const icons = {};
        const values = {};
        for (const id of ids) {
            const look = moduleLook(this._state.modules.find(item => item.id === id), this._state);
            if (look.icon) {
                icons[id] = new St.Icon({icon_size: size, style: `color: ${this._theme.fg};`});
                box.add_child(icons[id]);
            }
            if (look.value) {
                values[id] = id === 'network' && this._vertical ? this._sideways(this._theme.fg, 12) : readingLabel(this._theme.fg);
                box.add_child(values[id]);
            }
        }
        this._cleanups.push(this._overlay.services.subscribe(() => {
            const services = this._overlay.services;
            if (icons.volume)
                icons.volume.icon_name = services.volumeIcon;
            this._setReading(values.volume, services.stream?.is_muted ? 'Muted' : `${Math.round(services.volume * 100)}%`);
            if (icons.network)
                icons.network.icon_name = services.networkInfo.icon;
            this._setReading(values.network, services.networkInfo.short);
            this._setReading(values.battery, services.batteryInfo.present ? `${services.batteryInfo.percent}%` : 'AC');
            if (icons.battery) {
                icons.battery.icon_name = services.batteryInfo.icon;
                icons.battery.visible = services.batteryInfo.present || !values.battery;
            }
        }));
    }

    _statusGroup(size, ids = null) {
        const wanted = ids ?? this._state.modules.map(item => item.id).filter(id => ['volume', 'network', 'battery'].includes(id));
        const box = new St.BoxLayout({orientation: this._content.orientation, style: 'spacing: 10px;'});
        const button = new St.Button({child: box, track_hover: true, accessible_name: 'Quick controls'});
        const icons = {};
        const values = {};
        for (const id of wanted) {
            const look = moduleLook(this._state.modules.find(item => item.id === id), this._state);
            if (look.icon) {
                icons[id] = new St.Icon({icon_size: size, style: `color: ${this._theme.fg};`});
                box.add_child(icons[id]);
            }
            if (look.value) {
                values[id] = id === 'network' && this._vertical ? this._sideways(this._theme.fg, 12) : readingLabel(this._theme.fg);
                box.add_child(values[id]);
            }
        }
        const services = this._overlay.services;
        this._cleanups.push(services.subscribe(() => {
            if (icons.volume)
                icons.volume.icon_name = services.volumeIcon;
            this._setReading(values.volume, services.stream?.is_muted ? 'Muted' : `${Math.round(services.volume * 100)}%`);
            if (icons.network)
                icons.network.icon_name = services.networkInfo.icon;
            this._setReading(values.network, services.networkInfo.short);
            this._setReading(values.battery, services.batteryInfo.present ? `${services.batteryInfo.percent}%` : 'AC');
            button.accessible_name = `${services.networkInfo.text}; ${services.batteryInfo.text}`;
            if (icons.battery) {
                icons.battery.icon_name = services.batteryInfo.icon;
                icons.battery.visible = services.batteryInfo.present || !values.battery;
            }
        }));
        const layout = sliderLayout(this._state.modules.find(item => item.id === 'volume'), this._overlay._settings);
        const openId = layout === 'edge' ? 'osd' : 'status';
        const build = () => {
            if (wanted.length === 1 && (wanted[0] !== 'volume' || layout === 'drawer'))
                return this._groupItem({module: wanted[0], view: 'full'});
            const body = layout === 'edge' ? buildOsd(this) : layout === 'stack' ? buildStacked(this) : this._statusPanel();
            if (layout === 'drawer' || !wanted.includes('network'))
                return body;
            const line = this._networkPopoutLine();
            if (!line)
                return body;
            const wrap = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style: 'spacing: 12px;'});
            wrap.add_child(line);
            wrap.add_child(body);
            return wrap;
        };
        button._activate = () => this._toggle(openId, button, build);
        button.connect('scroll-event', (_actor, event) => {
            services.setVolume(services.volume - scrollStep(event) * 0.05);
            return Clutter.EVENT_STOP;
        });
        this._hoverDrawer(openId, button, build, wanted.some(id => this._hoverFor(id)));
        return button;
    }

    _setReading(actor, text) {
        if (actor?._bezelVertical) {
            if (actor._bezelString === text)
                return;
            this._fitSideways(actor, text);
            if (this._box)
                this._place();
            return;
        }
        if (!actor || actor.text === text)
            return;
        actor.text = text;
        if (this._box)
            this._place();
    }

    _networkPopoutLine(options = null) {
        const module = this._state.modules.find(item => item.id === 'network') || {id: 'network', ...options};
        if (!switchOn(module, this._state, 'popValue'))
            return null;
        const name = label(this._theme.fg, 14, '');
        this._popupCleanups.push(this._overlay.services.subscribe(() => {
            name.text = this._overlay.services.networkInfo.text;
            name.visible = Boolean(name.text);
        }));
        return name;
    }

    _hoverDrawer(id, button, build, enabled) {
        button.track_hover = true;
        const timer = `_drawerHover_${id}`;
        button.connect('notify::hover', () => {
            this._cancel(timer);
            if (button.hover && enabled && !this._state.editMode && !Main.overview.visible) {
                this._later(timer, this._state.hoverDelay, () => {
                    if (button.hover && !Main.overview.visible && (this._popoutId !== id || this._popoutInstance !== (this._moduleInstance || null)))
                        this._open(id, button, build, null, true);
                });
            } else {
                this._closeSoon();
            }
        });
    }

    _toggle(id, anchor, build) {
        if (this._popoutId === id && this._popoutInstance === (this._moduleInstance || null))
            this._close(true);
        else
            this._open(id, anchor, build);
    }

    _open(id, anchor, build, edge = null, hover = false) {
        if (this._destroyed)
            return;
        if (this._popoutId === id && this._anchor === anchor) {
            if (!hover) { this._hoverPopup = false; this._cancel('_hoverWatch'); }
            this._cancel('_closeTimer');
            if (this._popupTarget === 0)
                this._animatePopup(1);
            return;
        }
        if (hover && this._overlay._bars.some(bar => bar !== (this._moduleOwner || this) && bar._containsPointer()))
            return;
        for (const bar of this._overlay._bars)
            bar._close();
        this._close();
        this._anchor = anchor;
        this._hoverPopup = hover;
        this._popoutId = id;
        this._popupInputHole = false;
        this._popoutInstance = this._moduleInstance || null;
        if (id === 'notifications') this._overlay._notifications?.setHistoryOpen(true);
        if (this._state.autohide)
            this._slide(true, false);
        const monitor = this._monitor;
        const edgeTrigger = edge !== null;
        const corners = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
        const rail = id === 'power' && powerLayout(this._state.modules.find(item => item.id === 'power'), this._overlay._settings) === 'rail';
        const osd = id === 'osd';
        const position = ['power', 'dashboard', 'notifications'].includes(id)
            ? this._overlay._settings.get_string(`${id}-position`) : osd ? 'right' : 'icon';
        let location = edgeTrigger ? `${edge}-center` : position;
        if (osd)
            location = 'right';
        if (id === 'notifications') {
            const saved = position === 'icon' ? 'top-right' : position;
            location = corners.includes(saved) || saved.endsWith('-center') ? saved : 'top-right';
        }
        if (location === 'icon' && id === 'power' && this._vertical && !this._state.margin && this._state.kind !== 'dock')
            location = `bottom-${this._state.edge}`;
        const radius = Math.max(12, this._state.radius);
        const frame = this._overlay._frames.get(monitor.index);
        if (location === 'icon' && frame)
            location = this._snapPopupLocation(monitor, frame.sides, anchor) ?? location;
        edge = location === 'icon' ? (edge ?? this._state.edge) : location.split('-')[0];
        if (!['top', 'bottom', 'left', 'right'].includes(edge)) edge = this._state.edge;
        const cornered = corners.includes(location);
        // Corner drawers always join the frame. Autohide rails only join while
        // they are a full-length edge; otherwise the card sits on the thin hide.
        const floating = (this._state.margin ?? 0) > 0;
        const attached = Boolean(frame) && !global.display.get_monitor_in_fullscreen(monitor.index)
            && (cornered || location !== 'icon' || id === 'launcher' || this._joinedAutohide
                || (this._state.kind !== 'dock' && !floating));
        this._popupFrame = attached ? frame : null;
        this._popupEdge = edge;
        this._popupLocation = location;
        const joined = cornered ? {
            'top-right': `0 0 0 ${radius}px`,
            'top-left': `0 0 ${radius}px 0`,
            'bottom-right': `${radius}px 0 0 0`,
            'bottom-left': `0 ${radius}px 0 0`,
        }[location] : {
            top: `0 0 ${radius}px ${radius}px`,
            bottom: `${radius}px ${radius}px 0 0`,
            left: `0 ${radius}px ${radius}px 0`,
            right: `${radius}px 0 0 ${radius}px`,
        }[edge];
        this._popupJoined = attached ? joined : `${radius}px`;
        const availableWidth = monitor.width - this._side.left - this._side.right - 16;
        const width = osd || rail ? (osd ? 88 : 80)
            : Math.min(id === 'dashboard' ? 520 : id === 'launcher' ? this._state.launcherWidth : id === 'notifications' ? 420 : id === 'status' ? 400 : id === 'clock' ? 360 : 320, availableWidth - radius * 2);
        this._popupWidth = width;
        this._popupCleanups = [];
        this._popupAuxActors = new Set();
        this._popupCloseOutside = true;
        this._popupShadow = this._popupShadowDepth(attached);
        this._popupPaintRadius = radius;
        this._popupChromeStyle = {
            bg: this._theme.bg, fg: this._theme.fg, attached, edge, location, radius,
            pad: osd || rail ? '12px 10px' : '18px',
        };
        this._popout = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            reactive: true, track_hover: true, can_focus: true, width,
            clip_to_allocation: false,
        });
        this._popupPlate = this._popupShadow > 0 ? this._popupBackdropPlate() : null;
        if (this._popupPlate)
            this._popout.add_child(this._popupPlate);
        this._popupBox = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL, reactive: true, track_hover: true,
            can_focus: true, x_expand: true, y_expand: true,
            style: this._popupCardStyle(attached ? joined : `${radius}px`),
        });
        this._popout.add_child(this._popupBox);
        this._popupLockedHeight = false;
        const content = build();
        this._popupChrome = content._bezelHeader ?? null;
        if (this._popupChrome)
            this._popupBox.add_child(this._popupChrome);
        const scroll = new St.ScrollView({
            style_class: 'bezel-popout-scroll', overlay_scrollbars: true,
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: id === 'dashboard' || id === 'shelf' || String(id).startsWith('group:') ? St.PolicyType.AUTOMATIC : St.PolicyType.NEVER,
            x_expand: true, y_expand: true,
        });
        const menu = this._menuPopup(id);
        scroll.clip_to_allocation = true;
        scroll.set_child(content);
        this._popupBox.add_child(decorateScroll(scroll, this._theme, !menu));
        this._popupFooter = content._bezelFooter ?? null;
        if (this._popupFooter) this._popupBox.add_child(this._popupFooter);
        this._popupScroll = scroll;
        this._popupContent = content;
        const linger = () => {
            if (this._popout.hover || this._popupBox.hover)
                this._cancel('_closeTimer');
            else
                this._closeSoon();
        };
        this._popout.connect('notify::hover', linger);
        this._popupBox.connect('notify::hover', linger);
        const persist = () => {
            this._persistPopup();
            return Clutter.EVENT_PROPAGATE;
        };
        this._popout.connect('button-press-event', persist);
        this._popupBox.connect('button-press-event', persist);
        // Capture, not bubble. The scroll view sits under the pointer and, with
        // no scrollbar, eats Wayland smooth-scroll before a parent handler runs.
        this._popout.connect('captured-event', (_actor, event) => {
            if (event.type() !== Clutter.EventType.SCROLL)
                return Clutter.EVENT_PROPAGATE;
            const adjustment = this._popupScroll?.vadjustment;
            const step = scrollStep(event);
            if (!step)
                return Clutter.EVENT_PROPAGATE;
            if (this._onPopupScroll?.(step))
                return Clutter.EVENT_STOP;
            const [px, py] = event.get_coords();
            const picked = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, px, py);
            const nested = scrollViewUnder(picked, this._popout, this._popupScroll);
            if (nested) {
                const adj = nested.vadjustment;
                const limit = adj.upper - adj.page_size;
                const next = clamp(adj.value + step * 36, adj.lower, Math.max(adj.lower, limit));
                if (next !== adj.value) {
                    adj.value = next;
                    return Clutter.EVENT_STOP;
                }
            }
            if (!adjustment)
                return Clutter.EVENT_PROPAGATE;
            const limit = adjustment.upper - adjustment.page_size;
            if (limit <= adjustment.lower + 1)
                return Clutter.EVENT_PROPAGATE;
            adjustment.value = clamp(adjustment.value + step * 48, adjustment.lower, limit);
            return Clutter.EVENT_STOP;
        });
        // Hide until the drawer has a real size and clip, otherwise the first
        // chrome frame lands at (0, 0) on the primary monitor.
        this._popout.opacity = 0;
        this._popupProgress = 0;
        if (id === 'power' && powerDim(this._state.modules.find(item => item.id === 'power'), this._overlay._settings))
            this._overlay._showDim(monitor, this._opening());
        chrome(this._popout, true, false);
        const app = String(id).startsWith('app:');
        const stable = id === 'dashboard' || id === 'osd' || id === 'clock' || id === 'shelf' || rail;
        if (!app && !stable) {
            const requestFit = () => {
                if ((this._popupProgress ?? 0) < 1)
                    return;
                this._later('_fitPopupId', 40, () => this._fitPopup());
            };
            content.connect('notify::allocation', requestFit);
        }
        if (id === 'dashboard' && this._popupLockedHeight)
            this._placePopup();
        else
            this._fitPopup();
        this._clipPopup(0);
        this._popout.opacity = 255;
        this._animatePopup(1);
        this._press = global.stage.connect('captured-event', (_stage, event) => {
            if (event.type() === Clutter.EventType.KEY_PRESS && event.get_key_symbol() === Clutter.KEY_Escape) {
                const auxiliary = [...(this._popupAuxActors ?? [])].find(actor => actor._bezelCloseOnEscape);
                if (auxiliary) { auxiliary._bezelCloseOnEscape(); return Clutter.EVENT_STOP; }
                if (this._dashboardGesture) {
                    this._dashboardGesture();
                    return Clutter.EVENT_STOP;
                }
                const focus = this._anchor;
                this._close(true);
                if (focus?.can_focus)
                    focus.grab_key_focus();
                return Clutter.EVENT_STOP;
            }
            if (this._popupCloseOutside !== false && (event.type() === Clutter.EventType.BUTTON_PRESS || event.type() === Clutter.EventType.TOUCH_BEGIN)) {
                const [px, py] = event.get_coords();
                const picked = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, px, py);
                if (!picked)
                    return Clutter.EVENT_PROPAGATE;
                if (!this._popout.contains(picked) && picked !== this._popout
                    && !this._anchor?.contains(picked) && picked !== this._anchor
                    && ![...(this._popupAuxActors ?? [])].some(actor => actor === picked || actor.contains(picked)))
                    this._close(true);
            }
            return Clutter.EVENT_PROPAGATE;
        });
        if (!hover) {
            this._persistPopup();
            (this._popupBox ?? this._popout).grab_key_focus();
        }
        else
            this._watchHoverPopup();
    }

    _persistPopup() {
        this._hoverPopup = false;
        this._cancel('_hoverWatch');
        this._outsideSince = 0;
        this._enableOutsideDismiss();
    }

    _resetOutsideDismiss() {
        if (this._dismissStrips?.length) {
            for (const strip of this._dismissStrips)
                drop(strip);
        } else {
            drop(this._dismissLayer);
        }
        this._dismissLayer = null;
        this._dismissStrips = null;
        this._enableOutsideDismiss();
    }

    _enableOutsideDismiss() {
        if (!this._popout || this._dismissLayer || this._popupCloseOutside === false)
            return;
        // Wayland client clicks never reach stage capture. A Shell chrome
        // layer under the drawer still sits above application windows.
        const dismiss = () => this._close(true);
        const wire = actor => {
            actor.connect('button-press-event', () => {
                dismiss();
                return Clutter.EVENT_STOP;
            });
            actor.connect('touch-event', (_actor, event) => {
                if (event.type() === Clutter.EventType.TOUCH_BEGIN) dismiss();
                return Clutter.EVENT_STOP;
            });
        };
        const placeBelow = actor => {
            const parent = actor.get_parent();
            const below = [this._popout, ...this._overlay._bars.map(bar => bar._actor), ...this._overlay._chrome]
                .find(item => item && item.get_parent() === parent);
            if (below)
                parent.set_child_below_sibling(actor, below);
        };
        if (this._popupInputHole) {
            // Separate strips, not one stage-sized parent, so the GTK shelf
            // keeps a real hole in the chrome input region.
            this._dismissStrips = [0, 1, 2, 3].map(() => {
                const strip = new St.Widget({reactive: true});
                chrome(strip, true, false);
                placeBelow(strip);
                wire(strip);
                return strip;
            });
            this._dismissLayer = this._dismissStrips[0];
            this._layoutDismissStrips();
            return;
        }
        const layer = new St.Widget({reactive: true, x: 0, y: 0});
        layer.add_constraint(new Clutter.BindConstraint({source: global.stage, coordinate: Clutter.BindCoordinate.SIZE}));
        chrome(layer, true, false);
        placeBelow(layer);
        wire(layer);
        this._dismissLayer = layer;
    }

    _layoutDismissStrips() {
        const strips = this._dismissStrips;
        if (!strips?.length)
            return;
        const sw = global.stage.width, sh = global.stage.height;
        const g = this._popupGeometry;
        if (!g) {
            strips[0].set_position(0, 0);
            strips[0].set_size(sw, sh);
            for (let i = 1; i < 4; i++)
                strips[i].set_size(0, 0);
            return;
        }
        const x = Math.max(0, Math.round(g.x));
        const y = Math.max(0, Math.round(g.y));
        const w = Math.max(0, Math.round(g.width));
        const h = Math.max(0, Math.round(g.height));
        strips[0].set_position(0, 0);
        strips[0].set_size(sw, y);
        strips[1].set_position(0, y);
        strips[1].set_size(x, h);
        strips[2].set_position(x + w, y);
        strips[2].set_size(Math.max(0, sw - x - w), h);
        strips[3].set_position(0, y + h);
        strips[3].set_size(sw, Math.max(0, sh - y - h));
    }

    _opening() {
        return this._popupFrame?.sides ?? this._side;
    }

    _snapPopupLocation(monitor, opening, anchor) {
        if (!anchor)
            return null;
        const [ax, ay] = anchor.get_transformed_position();
        const [aw, ah] = anchor.get_transformed_size();
        const midX = ax + aw / 2;
        const midY = ay + ah / 2;
        const left = monitor.x + opening.left;
        const right = monitor.x + monitor.width - opening.right;
        const top = monitor.y + opening.top;
        const bottom = monitor.y + monitor.height - opening.bottom;
        const reach = 120;
        const nearLeft = midX - left < reach;
        const nearRight = right - midX < reach;
        const nearTop = midY - top < reach;
        const nearBottom = bottom - midY < reach;
        if (nearTop && nearRight)
            return 'top-right';
        if (nearTop && nearLeft)
            return 'top-left';
        if (nearBottom && nearRight)
            return 'bottom-right';
        if (nearBottom && nearLeft)
            return 'bottom-left';
        return null;
    }

    _setPopupHeight(next) {
        if (!this._popout)
            return;
        const opening = this._opening();
        const edge = this._popupEdge;
        const radius = Math.max(12, this._state.radius);
        const side = edge === 'left' || edge === 'right';
        const join = side ? Math.max(24, radius + 10) : Math.max(16, radius);
        const maxHeight = this._monitor.height - opening.top - opening.bottom - join * 2;
        const height = Math.min(Math.max(64, next), maxHeight);
        // Resize the frame and viewport together. Animating only the outer actor
        // leaves its placement and clip behind the new content allocation.
        this._popout.height = height;
        this._popupPlate?._bezelSyncPlate?.();
        const scrolling = this._popupScrolls();
        if (scrolling && this._popupScroll) {
            const innerWidth = Math.max(1, this._popout.width - 36);
            const chrome = this._popupChrome?.get_preferred_height(innerWidth)[1] ?? 0;
            const footer = this._popupFooter?.get_preferred_height(innerWidth)[1] ?? 0;
            const room = Math.max(48, height - chrome - footer - (this._popoutId === 'launcher' || this._popoutId === 'dashboard' || String(this._popoutId).startsWith('group:') ? 36 : 24));
            this._popupScroll.height = room;
            this._popupScroll.get_parent().height = room;
        }
        this._placePopup();
        this._popupScroll?.get_parent?.()?._bezelSyncOverflow?.();
    }

    _menuPopup(id = this._popoutId) {
        const name = String(id ?? '');
        return name === 'bar-menu' || name.startsWith('add-') || name.startsWith('module-');
    }

    _popupScrolls() {
        return ['dashboard', 'notifications', 'launcher', 'settings', 'vpn', 'performance', 'timer', 'shortcuts', 'devices', 'input', 'shelf'].includes(this._popoutId)
            || String(this._popoutId).startsWith('group:') || this._menuPopup();
    }

    _fitPopup() {
        if (this._popupFitLock || (this._popupLockedHeight && this._popoutId !== 'dashboard') || !this._popout || !this._popupContent)
            return;
        const pad = this._popoutId === 'status' ? 52 : this._popoutId === 'osd' || powerLayout(this._state.modules.find(item => item.id === 'power'), this._overlay._settings) === 'rail' && this._popoutId === 'power' ? 24 : 36;
        const width = Math.max(1, this._popout.width - pad);
        const app = String(this._popoutId).startsWith('app:');
        const scrolling = this._popupScrolls();
        const cap = this._popoutId === 'dashboard' || String(this._popoutId).startsWith('group:') ? 900 : app ? 420 : this._popoutId === 'shelf' ? 560 : scrolling ? 480
            : ['dashboard', 'status', 'clock', 'osd', 'power'].includes(this._popoutId) ? 900 : 400;
        const extent = this._stackHeight(this._popupContent, width, scrolling ? 8000 : cap);
        let chrome = 0;
        if (this._popupChrome) {
            const [, header] = this._popupChrome.get_preferred_height(width);
            chrome = this._popoutId === 'launcher' ? header : Math.min(header, 160) + 10;
        }
        const minHeight = this._popoutId === 'launcher' ? 168 : app ? 280 : 64;
        const slack = ['notifications', 'status', 'launcher'].includes(this._popoutId) ? 12 : 0;
        const footer = this._popupFooter?.get_preferred_height(width)[1] ?? 0;
        const wanted = Math.max(minHeight, extent + pad + chrome + footer + slack);
        this._setPopupHeight(scrolling ? Math.min(wanted, cap) : wanted);
        if (scrolling && this._popoutId !== 'launcher' && wanted > cap + 8)
            this._popupLockedHeight = true;
        if (this._popoutId === 'dashboard')
            this._popupLockedHeight = true;
    }

    _stackHeight(actor, width, cap) {
        if (!actor)
            return 0;
        // Let St account for theme padding, margins, spacing and actual column
        // widths. Hand-summing descendants misses nested and wrapped content.
        const [, natural] = actor.get_preferred_height(width);
        return Math.min(cap, Math.max(0, Math.ceil(natural)));
    }

    _placePopup() {
        if (!this._popout)
            return;
        const monitor = this._monitor;
        const edge = this._popupEdge;
        const location = this._popupLocation ?? 'icon';
        const attached = Boolean(this._popupFrame);
        const opening = this._opening();
        const radius = Math.max(12, this._state.radius);
        const width = this._popout.width;
        const availableWidth = monitor.width - opening.left - opening.right - 16;
        const [ax, ay] = (this._anchor ?? this._actor).get_transformed_position();
        const [aw, ah] = (this._anchor ?? this._actor).get_transformed_size();
        let x = ax + aw / 2 - width / 2;
        let y = ay + ah / 2 - this._popout.height / 2;
        if (edge === 'top') {
            if (location.endsWith('-center')) x = monitor.x + opening.left + (availableWidth + 16 - width) / 2;
            y = attached ? monitor.y + opening.top : (this._state.edge === 'top' ? this._box.y + this._box.height + 8 : monitor.y + opening.top + 8);
        } else if (edge === 'bottom') {
            if (location.endsWith('-center')) x = monitor.x + opening.left + (availableWidth + 16 - width) / 2;
            const dock = this._overlay._bars.find(bar => bar._monitor?.index === monitor.index && bar._state.edge === 'bottom' && bar._box);
            const shelf = this._state.edge === 'bottom' ? this._box.y : dock?._box?.y;
            y = attached ? monitor.y + monitor.height - opening.bottom - this._popout.height
                : (shelf ?? (monitor.y + monitor.height - opening.bottom)) - this._popout.height - 8;
        } else if (edge === 'left') {
            x = attached ? monitor.x + opening.left : this._box.x + this._box.width + 8;
        } else {
            x = attached ? monitor.x + monitor.width - opening.right - width : this._box.x - width - 8;
        }
        if (location === 'left' || location === 'right' || location === 'left-center' || location === 'right-center')
            y = monitor.y + opening.top + Math.max(0, (monitor.height - opening.top - opening.bottom - this._popout.height) / 2);
        if (location.endsWith('-right')) x = monitor.x + monitor.width - opening.right - width;
        if (location.endsWith('-left')) x = monitor.x + opening.left;
        const side = edge === 'left' || edge === 'right';
        const join = side ? Math.max(24, radius + 10) : 0;
        x = clamp(x, monitor.x + opening.left, monitor.x + monitor.width - opening.right - width);
        y = clamp(y, monitor.y + opening.top + join,
            monitor.y + monitor.height - opening.bottom - this._popout.height - join);
        const geometry = {x, y, width, height: this._popout.height, edge,
            corner: ['top-right', 'top-left', 'bottom-right', 'bottom-left'].includes(location) ? location : false};
        if (this._popupGeometry && ['x', 'y', 'width', 'height'].every(key => Math.abs(this._popupGeometry[key] - geometry[key]) < 1))
            return;
        this._popout.set_position(x, y);
        this._popupGeometry = geometry;
        this._layoutDismissStrips();
        this._clipPopup(this._popupProgress);
    }

    _clipPopup(progress = this._popupProgress ?? 0) {
        if (!this._popout || !this._popupGeometry)
            return;
        const {width, height, edge, corner} = this._popupGeometry;
        const horizontal = edge === 'left' || edge === 'right';
        const depth = (horizontal ? width : height) * progress;
        const attach = Boolean(this._popupFrame);
        const pad = this._popupPlate ? (this._popupShadow ?? 0) : 0;
        this._popout.set_clip((edge === 'right' ? width - depth : 0) - pad,
            (edge === 'bottom' ? height - depth : 0) - pad,
            Math.max(0, horizontal ? depth : width) + pad * 2,
            Math.max(0, horizontal ? height : depth) + pad * 2);
        if (attach && (progress <= 0 || progress >= 1))
            this._applyPopupJoin(this._state.radius, progress >= 1);
        if (progress <= 0) {
            this._popupFrame?.setPopup(null);
            return;
        }
        this._popupFrame?.setPopup({
            x: this._popupGeometry.x,
            y: this._popupGeometry.y,
            width, height, edge,
            corner: corner || false,
            progress,
        });
    }

    _applyPopupJoin(join, finished = false) {
        const chrome = this._popupChromeStyle;
        if (!chrome || !this._popout)
            return;
        const radii = finished && this._popupJoined ? this._popupJoined : ({
            'top-right': `0 0 0 ${Math.round(join)}px`,
            'top-left': `0 0 ${Math.round(join)}px 0`,
            'bottom-right': `${Math.round(join)}px 0 0 0`,
            'bottom-left': `0 ${Math.round(join)}px 0 0`,
            top: `0 0 ${Math.round(join)}px ${Math.round(join)}px`,
            bottom: `${Math.round(join)}px ${Math.round(join)}px 0 0`,
            left: `0 ${Math.round(join)}px ${Math.round(join)}px 0`,
            right: `${Math.round(join)}px 0 0 ${Math.round(join)}px`,
        }[this._popupLocation] ?? {
            top: `0 0 ${Math.round(join)}px ${Math.round(join)}px`,
            bottom: `${Math.round(join)}px ${Math.round(join)}px 0 0`,
            left: `0 ${Math.round(join)}px ${Math.round(join)}px 0`,
            right: `${Math.round(join)}px 0 0 ${Math.round(join)}px`,
        }[chrome.edge] ?? `${chrome.radius}px`);
        const card = this._popupBox ?? this._popout;
        const next = this._popupCardStyle(radii);
        if (card.get_style() !== next)
            card.set_style(next);
        this._popupPlate?._bezelSyncPlate?.();
    }

    _containsPointer() {
        if (!this._popout)
            return false;
        if (this._popout.hover || this._popupBox?.hover || this._anchor?.hover)
            return true;
        const [x, y] = global.get_pointer();
        return inside(this._popout, x, y, 24) || inside(this._anchor, x, y, 12) || this._insideGeometry(x, y, 24);
    }

    _insideGeometry(x, y, pad = 0) {
        const geometry = this._popupGeometry;
        return Boolean(geometry) && x >= geometry.x - pad && x <= geometry.x + geometry.width + pad
            && y >= geometry.y - pad && y <= geometry.y + geometry.height + pad;
    }

    _watchHoverPopup() {
        if (!this._popout || !this._hoverPopup || this._popupTarget === 0) return;
        if (this._containsPointer()) {
            this._outsideSince = 0;
        } else {
            this._outsideSince ||= GLib.get_monotonic_time();
            if (GLib.get_monotonic_time() - this._outsideSince >= 300000) {
                this._close(true);
                return;
            }
        }
        this._later('_hoverWatch', 100, () => this._watchHoverPopup());
    }

    _closeSoon() {
        if (this._hoverPopup && !this._hoverWatch)
            this._watchHoverPopup();
    }

    _animatePopup(target, complete = null) {
        this._popupTimeline?.stop();
        this._popupTarget = target;
        const from = this._popupProgress;
        const duration = allowsMotion(St.Settings.get(), St.ReducedMotion)
            ? Math.round(this._state.animationDuration * Math.abs(target - from) * (target === 0 ? 0.65 : 1)) : 0;
        const paint = progress => {
            if (!this._popout)
                return;
            this._popupProgress = progress;
            this._clipPopup(progress);
        };
        if (!duration) {
            paint(target);
            if (target === 1)
                this._fitPopup();
            complete?.();
            return;
        }
        const timeline = new Clutter.Timeline({duration, actor: this._popout});
        this._popupTimeline = timeline;
        timeline.set_progress_mode(Clutter.AnimationMode.EASE_OUT_EXPO);
        timeline.connect('new-frame', () => paint(from + (target - from) * timeline.get_progress()));
        timeline.connect('completed', () => {
            this._popupTimeline = null;
            paint(target);
            if (target === 1)
                this._fitPopup();
            complete?.();
        });
        paint(from);
        timeline.start();
    }

    _close(animate = false) {
        if (animate && this._popout && this._popupProgress > 0 && this._popout.visible && !this._popupInputHole) {
            this._animatePopup(0, () => this._close());
            return;
        }
        this._popupTimeline?.stop();
        this._popupTimeline = null;
        if (this._popoutId === 'notifications') this._overlay._notifications?.setHistoryOpen(false);
        this._popupFrame?.setPopup(null);
        this._popupFrame = null;
        this._popupGeometry = null;
        this._cancel('_appHover');
        this._cancel('_hoverWatch');
        this._outsideSince = 0;
        this._cancel('_closeTimer');
        for (const id of ['status', 'clock', 'power', 'dashboard'])
            this._cancel(`_drawerHover_${id}`);
        if (this._popoutId) this._cancel(`_drawerHover_${this._popoutId}`);
        this._cancel('_dashboardTimer');
        this._cancel('_fitPopupId');
        this._cancel('_deviceListFitId');
        this._popupFitLock = false;
        this._popupLockedHeight = false;
        this._overlay._hideDim();
        for (const cleanup of this._popupCleanups ?? [])
            cleanup();
        this._popupCleanups = [];
        this._popoutId = null;
        this._anchor = null;
        if (this._press) {
            global.stage.disconnect(this._press);
            this._press = 0;
        }
        if (global.stage.key_focus && this._popout?.contains(global.stage.key_focus))
            global.stage.set_key_focus(null);
        if (this._dismissStrips?.length) {
            for (const strip of this._dismissStrips)
                drop(strip);
        } else {
            drop(this._dismissLayer);
        }
        this._dismissLayer = null;
        this._dismissStrips = null;
        this._popupInputHole = false;
        drop(this._popout);
        this._popout = null;
        this._popupBox = null;
        this._popupPlate = null;
        this._popupContent = null;
        this._popupAuxActors = null;
        this._popupChrome = null;
        this._popupFooter = null;
        this._popupScroll = null;
        this._launcherEntry = null;
        this._launcherWidget = null;
        if (this._state.autohide)
            this._slideLater();
    }

    _dashboard() {
        const widget = buildDashboard(this);
        this._dashboardWidget = widget;
        return widget;
    }

    _monthGrid(options = moduleFeatures(this, 'clock')) {
        return monthGrid(this._theme, date => { if (openCalendarDate(date)) this._close(); }, options);
    }

    _mediaCard(artwork = false, artSize = 84, options = moduleFeatures(this, 'media')) {
        const services = this._overlay.services;
        const box = card(this._theme);
        const art = new St.Icon({icon_name: 'audio-x-generic-symbolic', icon_size: artSize,
            x_align: Clutter.ActorAlign.CENTER, style: `color: ${this._theme.accent};`});
        if (artwork)
            box.add_child(art);
        const title = label(this._theme.fg, 16);
        const artist = label(this._theme.muted, 12);
        title.x_expand = true;
        artist.x_expand = true;
        title.width = Math.min(240, this._popout.width - 72);
        artist.width = title.width;
        box.add_child(title);
        box.add_child(artist);
        const controls = new St.BoxLayout({x_align: Clutter.ActorAlign.CENTER, style: 'spacing: 16px;'});
        const buttons = {};
        for (const [method, name, icon] of [
            ['Previous', 'Previous track', 'media-skip-backward-symbolic'],
            ['PlayPause', 'Play or pause', 'media-playback-start-symbolic'],
            ['Next', 'Next track', 'media-skip-forward-symbolic'],
        ]) {
            const button = this._button(icon, 22);
            button.accessible_name = name;
            button._activate = () => services.mediaAction(method);
            this._wire(button);
            controls.add_child(button);
            buttons[method] = button;
        }
        box.add_child(controls);
        if (options.mediaSeek) {
            const seek = new Slider.Slider(0); seek.x_expand = true; seek.accessible_name = 'Track position';
            const reading = label(this._theme.muted, 12, '');
            box.add_child(seek); if (options.mediaTime) box.add_child(reading);
            else reading.hide();
            let updating = false, dragging = false, pending = false, disposed = false;
            const cancel = new Gio.Cancellable();
            const time = value => { const seconds = Math.floor(value / 1e6); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`; };
            const apply = () => {
                const media = services.media;
                if (updating || !media?.canSeek || !media.duration || !media.trackId) return;
                media.proxy.call('SetPosition', new GLib.Variant('(ox)', [media.trackId, Math.round(seek.value * media.duration)]), Gio.DBusCallFlags.NONE, 3000, cancel,
                    (proxy, result) => { try { proxy.call_finish(result); } catch (error) { if (!cancel.is_cancelled()) console.warn(`Bezel seek: ${error.message}`); } });
            };
            seek.connect('drag-begin', () => { dragging = true; });
            seek.connect('drag-end', () => { dragging = false; apply(); });
            seek.connect('notify::value', () => { if (!dragging) apply(); });
            const update = () => {
                const media = services.media;
                seek.reactive = Boolean(media?.canSeek && media.duration && media.trackId);
                seek.visible = Boolean(media?.duration);
                if (!media?.duration) { reading.text = media ? 'Live / duration unavailable' : ''; return GLib.SOURCE_CONTINUE; }
                if (pending || dragging || disposed) return GLib.SOURCE_CONTINUE;
                pending = true;
                media.proxy.call('org.freedesktop.DBus.Properties.Get', new GLib.Variant('(ss)', ['org.mpris.MediaPlayer2.Player', 'Position']), Gio.DBusCallFlags.NONE, 3000, cancel,
                    (proxy, result) => {
                        pending = false;
                        try {
                            const [variant] = proxy.call_finish(result).deepUnpack();
                            const position = Number(variant?.deepUnpack?.() ?? variant);
                            if (disposed || dragging || services.media?.trackId !== media.trackId || services.media?.proxy !== media.proxy) return;
                            updating = true; seek.value = Math.max(0, Math.min(1, position / media.duration)); updating = false;
                            reading.text = `${time(position)} / ${time(media.duration)}`;
                        } catch { if (!disposed) reading.text = 'Position unavailable'; }
                    });
                return GLib.SOURCE_CONTINUE;
            };
            update(); const timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, update);
            box.connect('destroy', () => { disposed = true; cancel.cancel(); GLib.source_remove(timer); if (!options.mediaTime) reading.destroy(); });
        }
        box._dashLayout = ({height}) => {
            const factor = height ? Math.max(0.6, Math.min(2.1, height / 230)) : 1;
            if (artwork)
                art.icon_size = Math.max(32, Math.round(artSize * factor));
            title.style = `color: ${this._theme.fg}; font-size: ${Math.max(12, Math.round(16 * factor))}px; font-weight: 600;`;
            artist.style = `color: ${this._theme.muted}; font-size: ${Math.max(10, Math.round(12 * factor))}px;`;
            for (const button of controls.get_children()) {
                if (button.child?.icon_size)
                    button.child.icon_size = Math.max(16, Math.round(22 * factor));
            }
        };
        this._popupCleanups.push(services.subscribe(() => {
            const media = services.media;
            if (artwork) {
                art.gicon = media?.artUrl?.startsWith('file://') ? new Gio.FileIcon({file: Gio.File.new_for_uri(media.artUrl)}) : new Gio.ThemedIcon({name: 'audio-x-generic-symbolic'});
            }
            title.text = media?.title ?? 'Nothing playing';
            artist.text = media ? media.artist || (media.playing ? 'Now playing' : 'Paused') : 'Play music or a video in a compatible app';
            controls.visible = Boolean(media);
            buttons.PlayPause.child.icon_name = media?.playing ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
            buttons.PlayPause.reactive = Boolean(media?.playing ? media.canPause : media?.canPlay);
            buttons.Previous.reactive = Boolean(media?.canPrevious);
            buttons.Next.reactive = Boolean(media?.canNext);
        }));
        return box;
    }

    _calendar(ids = null) {
        const members = ids ?? this._state.modules.filter(item => item.group === 'clock' || item.id === 'clock' || item.id === 'date').map(item => item.id);
        const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style: 'spacing: 8px;'});
        const options = moduleFeatures(this, 'clock');
        if (options.calendarTime) box.add_child(this._groupItem({module: 'clock'}));
        if (options.calendarDate) box.add_child(this._groupItem({module: 'date'}));
        if (options.calendarGrid) box.add_child(this._monthGrid(options));
        if (members.includes('weather'))
            box.add_child(weatherWidget(this));
        if (options.calendarNotifications) box.add_child(this._groupItem({module: 'notifications'}));
        return box;
    }

    _osdPanel() {
        return buildOsd(this);
    }

    _session(options = moduleFeatures(this, 'power')) {
        if (options.powerStyle ? options.powerStyle === 'rail' : options.powerIcons || powerLayout(this._state.modules.find(item => item.id === 'power'), this._overlay._settings) === 'rail')
            return buildSessionRail(this, options);
        const actions = SystemActions.getDefault();
        const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style: 'spacing: 8px;'});
        const rows = [
            ['Lock', 'system-lock-screen-symbolic', actions.can_lock_screen, () => actions.activateLockScreen()],
            ['Suspend', 'media-playback-pause-symbolic', actions.can_suspend, () => actions.activateSuspend()],
            ['Log out', 'system-log-out-symbolic', actions.can_logout, () => actions.activateLogout()],
            ['Restart', 'system-reboot-symbolic', actions.can_restart, () => actions.activateRestart()],
            ['Power off', 'system-shutdown-symbolic', actions.can_power_off, () => actions.activatePowerOff()],
        ];
        for (const [title, iconName, allowed, run] of rows) {
            const key = {'Lock': 'powerLock', 'Suspend': 'powerSuspend', 'Log out': 'powerLogout', 'Restart': 'powerRestart', 'Power off': 'powerOff'}[title];
            if (!allowed || options[key] === false)
                continue;
            const button = new St.Button({
                reactive: true,
                can_focus: true,
                style_class: 'bezel-action',
                x_expand: true,
                style: `border-radius: 16px; background-color: ${this._theme.surface}; padding: 12px 10px;`,
                child: row(iconName, title, this._theme),
            });
            button.connect('clicked', () => {
                this._close();
                run();
            });
            box.add_child(button);
        }
        return box;
    }

    _action(title, icon, run) {
        const button = new St.Button({
            can_focus: true, x_expand: true, style_class: 'bezel-action',
            style: `background-color: ${this._theme.surface}; color: ${this._theme.fg}; border-radius: 14px; padding: 12px 10px;`,
            child: row(icon, title, this._theme),
        });
        button.connect('clicked', () => { this._close(); run(); });
        return button;
    }

    _statusPanel() {
        const services = this._overlay.services;
        const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style: 'spacing: 14px;'});
        const title = label(this._theme.fg, 18, 'Quick controls');
        box.add_child(title);
        box.add_child(buildStacked(this));
        const networkModule = this._state.modules.find(item => item.id === 'network');
        const showName = switchOn(networkModule, this._state, 'popValue');
        const network = label(this._theme.fg, 13);
        const battery = label(this._theme.fg, 13);
        network.visible = showName;
        box.add_child(network);
        box.add_child(battery);
        this._popupCleanups.push(services.subscribe(() => {
            network.text = showName ? services.networkInfo.text : '';
            network.visible = showName && Boolean(network.text);
            battery.text = services.batteryInfo.text;
        }));
        box.add_child(buildDeviceControls(this));
        return box;
    }

    _levelSlider(box, caption, name, getValue, setValue, captionText, getMax) {
        const services = this._overlay.services;
        const slider = new Slider.Slider(0);
        slider.accessible_name = name;
        slider.style = `height: 28px; -barlevel-height: 24px; -slider-handle-radius: 0px; color: ${this._theme.accent}; -barlevel-active-background-color: ${this._theme.accent}; -barlevel-background-color: ${this._theme.border};`;
        let updating = false;
        slider.connect('notify::value', () => {
            if (!updating)
                setValue(slider.value);
        });
        box.add_child(slider);
        this._popupCleanups.push(services.subscribe(() => {
            updating = true;
            slider.maximum_value = getMax();
            slider.overdrive_start = 1;
            slider.value = getValue();
            if (caption) {
                caption.text = captionText();
                caption.visible = Boolean(caption.text);
            }
            updating = false;
        }));
        return slider;
    }

}

function row(iconName, text, theme) {
    const box = new St.BoxLayout({style: 'spacing: 10px;'});
    box.add_child(new St.Icon({icon_name: iconName, icon_size: 18, style: `color: ${theme.fg};`}));
    box.add_child(label(theme.fg, 14, text));
    return box;
}

function readingLabel(color) {
    const widget = label(color, 12);
    widget.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    return widget;
}

function label(color, size, text = '') {
    return new St.Label({
        text,
        x_align: Clutter.ActorAlign.CENTER,
        style: `color: ${color}; font-size: ${size}px; font-weight: 600;`,
    });
}

function now(format) {
    return (GLib.DateTime.new_now_local().format(format) ?? '').trim();
}

function strut(monitor, edge, thickness) {
    const actor = new St.Widget({reactive: false, opacity: 0});
    let x = monitor.x;
    let y = monitor.y;
    let width = monitor.width;
    let height = monitor.height;
    if (edge === 'top')
        height = thickness;
    else if (edge === 'bottom') {
        y = monitor.y + monitor.height - thickness;
        height = thickness;
    } else if (edge === 'left')
        width = thickness;
    else {
        x = monitor.x + monitor.width - thickness;
        width = thickness;
    }
    actor.set_position(x, y);
    actor.set_size(width, height);
    Main.layoutManager.addChrome(actor, {
        ...chromeOptions(Config.PACKAGE_VERSION, false, true),
    });
    return actor;
}

function innerCorner(px, py, radius, color, corner) {
    const area = new St.DrawingArea({
        reactive: false,
        width: radius,
        height: radius,
        style: 'background-color: transparent;',
    });
    area.set_position(px, py);
    area.set_size(radius, radius);
    area.connect('repaint', self => {
        let cr;
        try {
            cr = self.get_context();
        } catch {
            return;
        }
        if (!cr)
            return;
        try {
            const [width, height] = self.get_surface_size();
            paintCorner(cr, width, height, color, corner);
        } finally {
            cr.$dispose();
        }
    });
    area.connect('notify::allocation', () => area.queue_repaint());
    chrome(area, false);
    area.queue_repaint();
    return area;
}

function card(theme, child = null) {
    const box = new St.BoxLayout({
        orientation: Clutter.Orientation.VERTICAL,
        style: `background-color: ${theme.surface}; border-radius: 22px; padding: 14px; spacing: 6px;`,
    });
    if (child)
        box.add_child(child);
    return box;
}


function systemStats() {
    const stats = {memory: '—', load: '—', uptime: '—'};
    try {
        const mem = readFile('/proc/meminfo');
        const total = Number(/MemTotal:\s+(\d+)/.exec(mem)?.[1] ?? 0);
        const avail = Number(/MemAvailable:\s+(\d+)/.exec(mem)?.[1] ?? 0);
        if (total)
            stats.memory = `${((total - avail) / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} GiB`;
        const up = Number(readFile('/proc/uptime').split(' ')[0]);
        const hours = Math.floor(up / 3600);
        const minutes = Math.floor((up % 3600) / 60);
        stats.uptime = `${hours}h ${minutes}m`;
        stats.load = readFile('/proc/loadavg').split(' ').slice(0, 3).join('  ');
    } catch {
        // leave the placeholders
    }
    return stats;
}

function readFile(path) {
    const [, bytes] = GLib.file_get_contents(path);
    return new TextDecoder().decode(bytes);
}

function chrome(actor, input, trackFullscreen = true) {
    Main.layoutManager.addChrome(actor, {
        ...chromeOptions(Config.PACKAGE_VERSION, input, false, trackFullscreen),
    });
}

function drop(actor) {
    if (!actor)
        return;
    Main.layoutManager.removeChrome(actor);
    actor.destroy();
}

function inside(actor, x, y, pad = 0) {
    if (!actor)
        return false;
    try {
        const [ax, ay] = actor.get_transformed_position();
        const [aw, ah] = actor.get_transformed_size();
        return x >= ax - pad && x <= ax + aw + pad && y >= ay - pad && y <= ay + ah + pad;
    } catch {
        return false;
    }
}


function scrollViewUnder(actor, stop, outer) {
    for (let node = actor; node && node !== stop; node = node.get_parent?.()) {
        if (node instanceof St.ScrollView && node !== outer && node.vadjustment)
            return node;
    }
    return null;
}

function scrollStep(event) {
    const direction = event.get_scroll_direction();
    if (direction === Clutter.ScrollDirection.UP || direction === Clutter.ScrollDirection.LEFT)
        return -1;
    if (direction === Clutter.ScrollDirection.DOWN || direction === Clutter.ScrollDirection.RIGHT)
        return 1;
    const [dx, dy] = event.get_scroll_delta();
    return Math.sign(Math.abs(dy) > Math.abs(dx) ? dy : dx);
}

function launchSettings(panel) {
    try {
        Gio.Subprocess.new(['gnome-control-center', ...(panel ? [panel] : [])], Gio.SubprocessFlags.NONE);
    } catch (error) {
        Main.notifyError('Could not open Settings', error.message);
    }
}
