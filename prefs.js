import Adw from 'gi://Adw';
import Gio from 'gi://Gio';

import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class NowPlayPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_default_size(580, 620);
        const page = new Adw.PreferencesPage({ title: 'Hover Area', icon_name: 'input-mouse-symbolic' });
        window.add(page);

        const location = new Adw.PreferencesGroup({
            title: 'Open the player',
            description: 'Move the pointer into an invisible area on your primary display. The player opens beside it, independently of the clock. Changes apply immediately.',
        });
        page.add(location);
        for (const [key, title, subtitle] of [
            ['hover-area-x', 'Horizontal position', '0% = left · 50% = center · 100% = right'],
            ['hover-area-y', 'Vertical position', '0% = top · 50% = center · 100% = bottom'],
        ]) {
            const row = Adw.SpinRow.new_with_range(0, 100, 1);
            row.title = title;
            row.subtitle = subtitle;
            location.add(row);
            settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
        }

        const size = new Adw.PreferencesGroup({ title: 'Area size', description: 'Sizes use logical pixels and follow your display scaling.' });
        page.add(size);
        for (const [key, title, min, max] of [
            ['hover-area-width', 'Width', 10, 2000],
            ['hover-area-height', 'Height', 2, 1000],
        ]) {
            const row = Adw.SpinRow.new_with_range(min, max, 1);
            row.title = title;
            size.add(row);
            settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
        }
        const preview = new Adw.SwitchRow({
            title: 'Show area outline',
            subtitle: 'Turn this on to see where the area is, then turn it off to make it invisible.',
        });
        size.add(preview);
        settings.bind('show-hover-area', preview, 'active', Gio.SettingsBindFlags.DEFAULT);
    }
}
