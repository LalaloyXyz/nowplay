import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gtk from 'gi://Gtk';
import Pango from 'gi://Pango';

import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const PADDING = 44;

export default class NowPlayPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        window.set_title(settings.get_string('about-title'));
        window.set_default_size(665, 705);

        const page = new Adw.PreferencesPage();
        page.add_css_class('nowplay-prefs-page');

        const group = new Adw.PreferencesGroup();
        group.add_css_class('nowplay-prefs-group');

        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 0,
            margin_top: PADDING,
            margin_bottom: PADDING,
            margin_start: PADDING,
            margin_end: PADDING,
            halign: Gtk.Align.FILL,
            valign: Gtk.Align.FILL,
            hexpand: true,
            vexpand: true,
        });

        box.append(this._buildHero(settings));
        box.append(this._buildSupportSection(settings));
        box.append(this._buildResourcesSection(settings));

        group.add(box);
        page.add(group);
        window.add(page);

        this._loadStyles();
    }

    _buildHero(settings) {
        const hero = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 12,
            margin_bottom: 54,
            halign: Gtk.Align.CENTER,
        });

        const title = new Gtk.Label({
            label: settings.get_string('about-title'),
            halign: Gtk.Align.CENTER,
            justify: Gtk.Justification.CENTER,
        });
        title.add_css_class('nowplay-title');

        const subtitle = new Gtk.Label({
            label: settings.get_string('about-subtitle'),
            halign: Gtk.Align.CENTER,
            justify: Gtk.Justification.CENTER,
            wrap: true,
            max_width_chars: 42,
        });
        subtitle.add_css_class('nowplay-subtitle');

        const badge = new Gtk.Label({
            label: settings.get_string('version-label'),
            margin_top: 22,
            halign: Gtk.Align.CENTER,
        });
        badge.add_css_class('nowplay-badge');

        hero.append(title);
        hero.append(subtitle);
        hero.append(badge);
        return hero;
    }

    _buildSupportSection(settings) {
        const section = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 10,
            margin_bottom: 30,
        });

        const heading = new Gtk.Label({
            label: settings.get_string('support-heading'),
            xalign: 0,
        });
        heading.add_css_class('nowplay-section-title');

        const subtitle = new Gtk.Label({
            label: settings.get_string('support-subtitle'),
            xalign: 0,
        });
        subtitle.add_css_class('nowplay-section-subtitle');

        section.append(heading);
        section.append(subtitle);
        section.append(this._buildLinkList(settings.get_value('support-links').deep_unpack(), 'emblem-favorite-symbolic'));
        return section;
    }

    _buildResourcesSection(settings) {
        const section = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 14,
        });

        const heading = new Gtk.Label({
            label: settings.get_string('resources-heading'),
            xalign: 0,
        });
        heading.add_css_class('nowplay-section-title');

        section.append(heading);
        section.append(this._buildLinkList(settings.get_value('resource-links').deep_unpack(), 'view-grid-symbolic'));
        return section;
    }

    _buildLinkList(links, iconName) {
        const list = new Gtk.ListBox({
            selection_mode: Gtk.SelectionMode.NONE,
            css_classes: ['nowplay-link-list'],
        });

        list._nowplayUrls = new Map();
        list.connect('row-activated', (_list, row) => {
            const url = list._nowplayUrls.get(row);
            if (url)
                Gtk.show_uri(null, url, Gdk.CURRENT_TIME);
        });

        for (const [title, subtitle, url] of links) {
            const row = this._buildLinkRow(title, subtitle, iconName);
            list._nowplayUrls.set(row, url);
            list.append(row);
        }

        return list;
    }

    _buildLinkRow(title, subtitle, iconName) {
        const row = new Gtk.ListBoxRow({
            activatable: true,
            selectable: false,
        });
        row.add_css_class('nowplay-link-row');

        const content = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 14,
            margin_top: 10,
            margin_bottom: 10,
            margin_start: 16,
            margin_end: 16,
        });

        const icon = new Gtk.Image({
            icon_name: iconName,
            pixel_size: 30,
            valign: Gtk.Align.CENTER,
        });
        icon.add_css_class('nowplay-row-icon');

        const labels = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 1,
            hexpand: true,
            valign: Gtk.Align.CENTER,
        });

        const titleLabel = new Gtk.Label({
            label: title,
            xalign: 0,
            ellipsize: Pango.EllipsizeMode.END,
        });
        titleLabel.add_css_class('nowplay-row-title');

        const subtitleLabel = new Gtk.Label({
            label: subtitle,
            xalign: 0,
            ellipsize: Pango.EllipsizeMode.END,
        });
        subtitleLabel.add_css_class('nowplay-row-subtitle');

        const openIcon = new Gtk.Image({
            icon_name: 'adw-external-link-symbolic',
            pixel_size: 18,
            valign: Gtk.Align.CENTER,
        });

        labels.append(titleLabel);
        labels.append(subtitleLabel);
        content.append(icon);
        content.append(labels);
        content.append(openIcon);
        row.set_child(content);

        return row;
    }

    _loadStyles() {
        const provider = new Gtk.CssProvider();
        provider.load_from_data(`
            .nowplay-prefs-page {
                background: #202126;
                color: #f5f5f7;
            }

            .nowplay-title {
                color: #ffffff;
                font-size: 28px;
                font-weight: 800;
            }

            .nowplay-subtitle,
            .nowplay-section-subtitle,
            .nowplay-row-subtitle {
                color: alpha(#ffffff, 0.58);
            }

            .nowplay-subtitle {
                font-size: 15px;
            }

            .nowplay-badge {
                min-width: 76px;
                padding: 10px 16px;
                border-radius: 999px;
                background: alpha(#ffffff, 0.09);
                color: #ffffff;
                font-weight: 800;
            }

            .nowplay-section-title {
                color: #ffffff;
                font-size: 15px;
                font-weight: 800;
            }

            .nowplay-section-subtitle {
                font-size: 15px;
            }

            .nowplay-link-list {
                background: alpha(#ffffff, 0.08);
                border: 1px solid alpha(#ffffff, 0.05);
                border-radius: 10px;
                color: #ffffff;
            }

            .nowplay-link-row {
                background: transparent;
                min-height: 56px;
            }

            .nowplay-link-row:hover {
                background: alpha(#ffffff, 0.05);
            }

            .nowplay-row-icon {
                color: #ffffff;
            }

            .nowplay-row-title {
                color: #ffffff;
                font-size: 15px;
            }

            .nowplay-row-subtitle {
                font-size: 13px;
            }
        `, -1);

        Gtk.StyleContext.add_provider_for_display(
            Gdk.Display.get_default(),
            provider,
            Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
        );
    }
}
