import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const BUS_NAME = 'org.freedesktop.NetworkManager';
const ROOT_PATH = '/org/freedesktop/NetworkManager';
const ROOT_IFACE = 'org.freedesktop.NetworkManager';
const SETTINGS_PATH = '/org/freedesktop/NetworkManager/Settings';
const SETTINGS_IFACE = 'org.freedesktop.NetworkManager.Settings';
const CONNECTION_IFACE = 'org.freedesktop.NetworkManager.Settings.Connection';
const ACTIVE_IFACE = 'org.freedesktop.NetworkManager.Connection.Active';
const ICON_NAME = 'network-wired-symbolic';
const SUPPORTED_TYPES = new Set(['macvlan', 'ipvlan']);

const gettext = (extension, message) => extension.gettext(message);

function makeProxy(path, iface) {
	return Gio.DBusProxy.new_for_bus_sync(
		Gio.BusType.SYSTEM,
		Gio.DBusProxyFlags.NONE,
		null,
		BUS_NAME,
		path,
		iface,
		null,
	);
}

function call(proxy, method, parameters, callback) {
	proxy.call(
		method,
		parameters,
		Gio.DBusCallFlags.NONE,
		-1,
		null,
		(source, result) => {
			try {
				callback(source.call_finish(result), null);
			} catch (e) {
				callback(null, e);
			}
		},
	);
}

function unpackSettings(variant) {
	// GetSettings returns (a{sa{sv}}). deep_unpack() leaves the inner 'v'
	// values as GLib.Variant objects, so `type`/`uuid` would not be strings
	// (and a Variant used as a Map key never matches). recursiveUnpack()
	// unwraps those variants too.
	const [settings] = variant.recursiveUnpack();
	const connection = settings.connection ?? {};
	return {
		uuid: connection.uuid,
		name: connection.id || connection.uuid,
		type: connection.type,
	};
}

const OtherNetworksMenuToggle = GObject.registerClass(
	class OtherNetworksMenuToggle extends QuickSettings.QuickMenuToggle {
		_init(extension) {
			super._init({
				title: gettext(extension, 'Other Networks'),
				iconName: ICON_NAME,
				toggleMode: true,
			});

			this._ = message => gettext(extension, message);
			this.menu.setHeader(ICON_NAME, this._('Other network connections'));
			this._disposed = false;
			this.visible = false;
			this._settingChecked = false;
			this._changing = new Set();
			this._connections = new Map(); // UUID -> {uuid, name, path}
			this._items = new Map();
			this._connectionProxies = new Map();
			this._activePaths = new Map(); // UUID -> active connection object path

			this._manager = makeProxy(ROOT_PATH, ROOT_IFACE);
			this._settings = makeProxy(SETTINGS_PATH, SETTINGS_IFACE);

			this.connect('notify::checked', () => {
				if (!this._settingChecked && !this._disposed)
					this._setAllConnections(this.checked);
			});

			this._settingsSignalIds = [
				this._settings.connect('g-signal', (_proxy, _sender, signal, params) => {
					if (signal === 'NewConnection') {
						const [path] = params.deep_unpack();
						this._loadConnection(path);
					} else if (signal === 'ConnectionRemoved') {
						const [path] = params.deep_unpack();
						this._removeConnection(path);
					}
				}),
			];
			this._managerSignalId = this._manager.connect('g-properties-changed',
				(_proxy, changed) => {
					if (changed.lookup_value('ActiveConnections', null))
						this._refreshActiveConnections();
				});

			call(this._settings, 'ListConnections', null, (result, error) => {
				if (this._disposed)
					return;
				if (error) {
					logError(error, 'Other Networks Quick Switch: NetworkManager ListConnections failed');
					return;
				}
				for (const path of result.deep_unpack()[0])
					this._loadConnection(path);
				this._refreshActiveConnections();
			});
		}

		_setChecked(value) {
			this._settingChecked = true;
			this.checked = value;
			this._settingChecked = false;
		}

		_loadConnection(path) {
			if (this._disposed || [...this._connectionProxies.values()].some(entry => entry.path === path))
				return;

			let proxy;
			try {
				proxy = makeProxy(path, CONNECTION_IFACE);
			} catch (e) {
				logError(e, `Other Networks Quick Switch: unable to open connection ${path}`);
				return;
			}

			const entry = {path, proxy, uuid: null};
			this._connectionProxies.set(path, entry);
			entry.signalId = proxy.connect('g-signal', (_p, _sender, signal) => {
				if (signal === 'Updated')
					this._readConnection(entry);
				else if (signal === 'Removed')
					this._removeConnection(path);
			});
			this._readConnection(entry);
		}

		_readConnection(entry) {
			call(entry.proxy, 'GetSettings', null, (result, error) => {
				if (this._disposed || !this._connectionProxies.has(entry.path))
					return;
				if (error) {
					logError(error, `Other Networks Quick Switch: unable to read connection ${entry.path}`);
					return;
				}

				const profile = unpackSettings(result);
				const previousUuid = entry.uuid;
				entry.uuid = profile.uuid;

				if (previousUuid && previousUuid !== profile.uuid)
					this._connections.delete(previousUuid);

				if (SUPPORTED_TYPES.has(profile.type) && profile.uuid) {
					this._connections.set(profile.uuid, {
						uuid: profile.uuid,
						name: profile.name,
						path: entry.path,
					});
				} else if (profile.uuid) {
					this._connections.delete(profile.uuid);
				}

				// Active-connection matching needs the profile UUID, which is only
				// known now, so re-evaluate the active set (this also updates the menu).
				this._refreshActiveConnections();
			});
		}

		_removeConnection(path) {
			const entry = this._connectionProxies.get(path);
			if (!entry)
				return;
			if (entry.signalId)
				entry.proxy.disconnect(entry.signalId);
			this._connectionProxies.delete(path);
			if (entry.uuid)
				this._connections.delete(entry.uuid);
			this._updateVisibilityAndMenu();
		}

		_refreshActiveConnections() {
			if (this._disposed)
				return;
			const value = this._manager.get_cached_property('ActiveConnections');
			const paths = value ? value.deep_unpack() : [];
			const active = new Map();
			let remaining = paths.length;

			if (remaining === 0) {
				this._activePaths = active;
				this._updateVisibilityAndMenu();
				return;
			}

			for (const path of paths) {
				let proxy;
				try {
					proxy = makeProxy(path, ACTIVE_IFACE);
				} catch (e) {
					if (--remaining === 0) {
						this._activePaths = active;
						this._updateVisibilityAndMenu();
					}
					continue;
				}

				const connectionValue = proxy.get_cached_property('Connection');
				const profilePath = connectionValue?.deep_unpack();
				if (!profilePath) {
					if (--remaining === 0) {
						this._activePaths = active;
						this._updateVisibilityAndMenu();
					}
					continue;
				}

				const profileEntry = [...this._connectionProxies.values()]
					.find(entry => entry.path === profilePath);
				if (profileEntry?.uuid)
					active.set(profileEntry.uuid, path);

				if (--remaining === 0) {
					this._activePaths = active;
					this._updateVisibilityAndMenu();
				}
			}
		}

		_updateVisibilityAndMenu() {
			if (this._disposed)
				return;
			this.visible = this._connections.size > 0;
			this._rebuildMenu();
			const activeCount = [...this._connections.keys()]
				.filter(uuid => this._activePaths.has(uuid)).length;
			this._setChecked(activeCount > 0);
			this.subtitle = this._('%d of %d active')
				.replace('%d', String(activeCount))
				.replace('%d', String(this._connections.size));
		}

		_rebuildMenu() {
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
				const item = new PopupMenu.PopupSwitchMenuItem(
					connection.name, this._activePaths.has(connection.uuid));
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

			const next = connections.filter(c => !this._changing.has(c.uuid));
			let index = 0;
			const runNext = () => {
				if (this._disposed || index >= next.length)
					return;
				this._setConnection(next[index++], enable, runNext);
			};
			runNext();
		}

		_setConnection(connection, enable, done = null) {
			if (this._changing.has(connection.uuid)) {
				done?.();
				return;
			}
			this._changing.add(connection.uuid);

			if (enable) {
				call(this._manager, 'ActivateConnection',
					new GLib.Variant('(ooo)', [connection.path, '/', '/']),
					(result, error) => {
						this._changing.delete(connection.uuid);
						if (this._disposed)
							return;
						if (error)
							logError(error, `Other Networks Quick Switch: failed to activate ${connection.name}`);
						this._refreshActiveConnections();
						done?.();
					});
				return;
			}

			const activePath = this._activePaths.get(connection.uuid);
			if (!activePath) {
				this._changing.delete(connection.uuid);
				done?.();
				return;
			}

			call(this._manager, 'DeactivateConnection',
				new GLib.Variant('(o)', [activePath]),
				(_result, error) => {
					this._changing.delete(connection.uuid);
					if (this._disposed)
						return;
					if (error)
						logError(error, `Other Networks Quick Switch: failed to deactivate ${connection.name}`);
					this._refreshActiveConnections();
					done?.();
				});
		}

		destroy() {
			this._disposed = true;
			if (this._settingsSignalIds) {
				for (const id of this._settingsSignalIds)
					this._settings.disconnect(id);
			}
			if (this._managerSignalId)
				this._manager.disconnect(this._managerSignalId);
			for (const entry of this._connectionProxies.values()) {
				if (entry.signalId)
					entry.proxy.disconnect(entry.signalId);
			}
			this._connectionProxies.clear();
			super.destroy();
		}
	});

export default class MacvlanQuickSwitchExtension extends Extension {
	enable() {
		this._toggle = new OtherNetworksMenuToggle(this);
		this._indicator = new QuickSettings.SystemIndicator();        
		this._indicator.quickSettingsItems.push(this._toggle);

		const quickSettings = Main.panel.statusArea.quickSettings;
		quickSettings.addExternalIndicator(this._indicator);

		// Best-effort placement immediately after GNOME's built-in wired tile.
		try {
			const wiredToggle = quickSettings._network?._wiredToggle;
			const grid = wiredToggle?.get_parent();
			if (grid && typeof grid.set_child_at_index === 'function') {
				const children = grid.get_children?.() ?? [];
				const wiredIndex = children.indexOf(wiredToggle);
				const ownIndex = children.indexOf(this._toggle);
				if (wiredIndex >= 0 && ownIndex >= 0)
					grid.set_child_at_index(this._toggle, wiredIndex + 1);
			}
		} catch (e) {
			log(`Other Networks Quick Switch: using default Quick Settings order: ${e.message}`);
		}
	}

	disable() {
		this._toggle?.destroy();
		this._toggle = null;

		this._indicator?.destroy();
		this._indicator = null;
	}
}
