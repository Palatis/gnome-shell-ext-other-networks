import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const POLL_INTERVAL_SECONDS = 5;
const ICON_NAME = 'network-wired-symbolic';
const SUPPORTED_TYPES = new Set(['macvlan', 'ipvlan']);

const gettext = (extension, message) => extension.gettext(message);

// nmcli's terse format escapes separators inside field values with backslashes.
function splitTerseLine(line) {
    const fields = [];
    let field = '';
    let escaped = false;

    for (const char of line) {
        if (escaped) {
            field += char;
            escaped = false;
        } else if (char === '\\') {
            escaped = true;
        } else if (char === ':') {
            fields.push(field);
            field = '';
        } else {
            field += char;
        }
    }

    if (escaped)
        field += '\\';
    fields.push(field);
    return fields;
}

const OtherNetworksMenuToggle = GObject.registerClass(
class OtherNetworksMenuToggle extends QuickSettings.QuickMenuToggle {
    _init(extension, indicatorIcon) {
        super._init({
            title: gettext(extension, 'Other Networks'),
            iconName: ICON_NAME,
            toggleMode: true,
        });

        this._ = message => gettext(extension, message);
        this._indicatorIcon = indicatorIcon;
        this.menu.setHeader(ICON_NAME, this._('Other network connections'));
        this._disposed = false;
        // Keep the Quick Settings item hidden until a supported connection is found.
        this.visible = false;
        this._settingChecked = false;
        this._changing = new Set();
        this._connections = new Map();
        this._items = new Map();
        this._refreshing = false;

        this.connect('notify::checked', () => {
            if (!this._settingChecked && !this._disposed)
                this._setAllConnections(this.checked);
        });

        this._pollSource = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            POLL_INTERVAL_SECONDS,
            () => {
                this._refresh();
                return GLib.SOURCE_CONTINUE;
            },
        );
        this._refresh();
    }

    _setChecked(value) {
        this._settingChecked = true;
        this.checked = value;
        this._settingChecked = false;
    }

    _runNmcli(args, callback) {
        let proc;
        try {
            proc = Gio.Subprocess.new(
                ['nmcli', ...args],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
            );
        } catch (e) {
            callback(false, '', e.message);
            return;
        }

        proc.communicate_utf8_async(null, null, (p, result) => {
            try {
                const [, stdout, stderr] = p.communicate_utf8_finish(result);
                callback(p.get_successful(), stdout ?? '', stderr ?? '');
            } catch (e) {
                callback(false, '', e.message);
            }
        });
    }

    _refresh() {
        if (this._disposed || this._refreshing)
            return;
        this._refreshing = true;

        this._runNmcli(
            ['-t', '-f', 'UUID,NAME,TYPE', 'connection', 'show'],
            (ok, stdout, stderr) => {
                if (this._disposed)
                    return;
                if (!ok) {
                    this._refreshing = false;
                    logError(new Error(`Other Networks Quick Switch: unable to list connections: ${stderr.trim()}`));
                    return;
                }

                const found = new Map();
                for (const line of stdout.split('\n')) {
                    if (!line)
                        continue;
                    const fields = splitTerseLine(line);
                    if (fields.length < 3 || !SUPPORTED_TYPES.has(fields[2]))
                        continue;
                    found.set(fields[0], {uuid: fields[0], name: fields[1] || fields[0]});
                }
                this._connections = found;
                // Hide the toggle entirely when no macvlan/ipvlan profiles exist.
                this.visible = found.size > 0;
                if (this._indicatorIcon)
                    this._indicatorIcon.visible = found.size > 0;
                this._syncActiveState();
            },
        );
    }

    _syncActiveState() {
        this._runNmcli(
            ['-t', '-f', 'UUID', 'connection', 'show', '--active'],
            (ok, stdout, stderr) => {
                if (this._disposed)
                    return;
                this._refreshing = false;
                if (!ok) {
                    logError(new Error(`Other Networks Quick Switch: unable to query active connections: ${stderr.trim()}`));
                    return;
                }

                const active = new Set(stdout.split('\n').map(line => line.trim()).filter(Boolean));
                this._rebuildMenu(active);
                const anyActive = [...this._connections.keys()].some(uuid => active.has(uuid));
                this._setChecked(anyActive);
                this.subtitle = this._connections.size === 0
                    ? this._('No macvlan/ipvlan connections')
                    : this._('%d of %d active').replace('%d', String([...this._connections.keys()].filter(uuid => active.has(uuid)).length)).replace('%d', String(this._connections.size));
            },
        );
    }

    _rebuildMenu(active) {
        this.menu.removeAll();
        this._items.clear();

        const connections = [...this._connections.values()].sort((a, b) =>
            a.name.localeCompare(b.name, undefined, {sensitivity: 'base'}));

        if (connections.length === 0) {
            const emptyItem = new PopupMenu.PopupMenuItem(this._('No macvlan/ipvlan connections found'));
            emptyItem.setSensitive(false);
            this.menu.addMenuItem(emptyItem);
            return;
        }

        for (const connection of connections) {
            const item = new PopupMenu.PopupSwitchMenuItem(connection.name, active.has(connection.uuid));
            item.connect('toggled', (_item, state) => {
                if (!this._disposed && !this._changing.has(connection.uuid))
                    this._setConnection(connection, state);
            });
            this.menu.addMenuItem(item);
            this._items.set(connection.uuid, item);
        }
    }

    _setAllConnections(enable) {
        const connections = [...this._connections.values()];
        if (connections.length === 0) {
            this._setChecked(false);
            return;
        }
        // Run operations serially to avoid racing NetworkManager state changes.
        const next = connections.filter(connection => !this._changing.has(connection.uuid));
        let index = 0;
        const runNext = () => {
            if (this._disposed || index >= next.length) {
                this._refresh();
                return;
            }
            const connection = next[index++];
            this._setConnection(connection, enable, runNext);
        };
        runNext();
    }

    _setConnection(connection, enable, done = null) {
        if (this._changing.has(connection.uuid)) {
            done?.();
            return;
        }
        this._changing.add(connection.uuid);
        const args = enable
            ? ['connection', 'up', 'uuid', connection.uuid]
            : ['connection', 'down', 'uuid', connection.uuid];

        this._runNmcli(args, (ok, stdout, stderr) => {
            this._changing.delete(connection.uuid);
            if (this._disposed)
                return;
            if (!ok) {
                logError(new Error(
                    `Other Networks Quick Switch: nmcli ${args.join(' ')} failed: ${stderr.trim() || stdout.trim() || 'unknown error'}`,
                ));
            }
            if (done)
                done();
            else
                this._refresh();
        });
    }

    destroy() {
        if (this._pollSource) {
            GLib.Source.remove(this._pollSource);
            this._pollSource = 0;
        }
        this._disposed = true;
        super.destroy();
    }
});

export default class MacvlanQuickSwitchExtension extends Extension {
    enable() {
        this._indicator = new QuickSettings.SystemIndicator();
        this._panelIcon = this._indicator._addIndicator();
        this._panelIcon.icon_name = ICON_NAME;
        this._panelIcon.visible = false;
        this._toggle = new OtherNetworksMenuToggle(this, this._panelIcon);
        this._indicator.quickSettingsItems.push(this._toggle);

        const quickSettings = Main.panel.statusArea.quickSettings;
        quickSettings.addExternalIndicator(this._indicator);

        // Best-effort placement immediately after GNOME's built-in network tile.
        // The grid and built-in tile references are private Shell APIs and may vary.
        try {
            const wiredToggle = quickSettings._network?._wiredToggle;
            const grid = wiredToggle?.get_parent();
            if (typeof grid.set_child_at_index === 'function') {
                const children = grid?.get_children?.() ?? [];
                const wiredIndex = children.indexOf(wiredToggle);
                const ownIndex = children.indexOf(this._toggle);
                if (wiredIndex >= 0 && ownIndex >= 0) {
                    log(`wiredIndex = {wiredIndex}, ownIndex = {ownIndex}`);    
                    grid.set_child_at_index(this._toggle, wiredIndex + 1);
                }
            }
        } catch (e) {
            // Keep GNOME's default placement if reordering is unsupported.
            log(`Other Networks Quick Switch: using default Quick Settings order: ${e.message}`);
        }
    }

    disable() {
        const quickSettings = Main.panel.statusArea.quickSettings;
        if (this._quickSettings && this._indicator) {
            this._quickSettings.removeExternalIndicator(this._indicator);
        }

        this._toggle?.destroy();
        this._toggle = null;

        this._indicator?.destroy();
        this._indicator = null;
        this._panelIcon = null;
    }
}
