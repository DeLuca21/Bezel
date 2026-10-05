import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// Keep only this lifecycle controller alive while locked. Desktop controls and
// keybindings are removed before drawing anything over the lock screen.
export class SessionMotion {
    constructor(settings, startDesktop, stopDesktop, revealDesktop, revealLock) {
        this._settings = settings;
        this._startDesktop = startDesktop;
        this._stopDesktop = stopDesktop;
        this._revealDesktop = revealDesktop;
        this._revealLock = revealLock;
        this._signals = [];
        const connect = (object, signal, callback) => {
            if (object) this._signals.push([object, object.connect(signal, callback)]);
        };
        connect(Main.sessionMode, 'updated', () => this.sync());
        connect(Main.screenShield?.actor, 'notify::visible', () => this.sync());
        connect(Main.layoutManager, 'monitors-changed', () => this._clearLock());
        connect(settings, 'changed::lock-animation', () => {
            if (!settings.get_boolean('lock-animation')) this._clearLock();
        });
        try { this.sync(); }
        catch (error) { this.destroy(); throw error; }
    }

    sync() {
        const mode = Main.sessionMode;
        if (mode.isLocked) {
            const entering = !this._locked;
            this._locked = true;
            this._unlockPending = true;
            this._stopDesktop();
            if (entering && this._settings.get_boolean('lock-animation')) {
                this._clearLock();
                try { this._lockAnimation = this._revealLock(); }
                catch (error) { console.error('Bezel lock animation failed', error); }
            }
            return;
        }
        this._locked = false;
        this._clearLock();
        if (mode.isGreeter || (mode.currentMode !== 'user' && mode.parentMode !== 'user')) {
            this._unlockPending = false;
            this._stopDesktop();
            return;
        }
        this._startDesktop();
        // Session mode returns to user before the shield finishes sliding away.
        // Wait for its actual disappearance so the reveal is visible in full.
        if (this._unlockPending && !Main.screenShield?.actor.visible) {
            this._unlockPending = false;
            if (this._settings.get_boolean('unlock-animation')) {
                try { this._revealDesktop(); }
                catch (error) { console.error('Bezel unlock animation failed', error); }
            }
        }
    }

    _clearLock() {
        this._lockAnimation?.destroy();
        this._lockAnimation = null;
    }

    destroy() {
        for (const [object, id] of this._signals) object.disconnect(id);
        this._signals = [];
        this._clearLock();
        this._stopDesktop();
    }
}
