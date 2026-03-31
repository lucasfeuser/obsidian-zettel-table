import { App, Plugin, PluginSettingTab, Setting } from 'obsidian';
import {
  ZettelTableSettings,
  ThemeMode,
  DateFormat,
  PillColor,
} from './types';

const PILL_COLORS: PillColor[] = [
  'red', 'orange', 'yellow', 'green', 'teal',
  'blue', 'indigo', 'purple', 'pink', 'gray',
];

const DATE_FORMATS: DateFormat[] = [
  'MMM D, YYYY',
  'YYYY-MM-DD',
  'D MMM YYYY',
  'MM/DD/YYYY',
];

export class ZettelTableSettingTab extends PluginSettingTab {
  private plugin: Plugin & { settings: ZettelTableSettings };
  private saveSettings: () => Promise<void>;
  private onSettingsChanged: () => void;

  constructor(
    app: App,
    plugin: Plugin & { settings: ZettelTableSettings },
    saveSettings: () => Promise<void>,
    onSettingsChanged: () => void
  ) {
    super(app, plugin);
    this.plugin = plugin;
    this.saveSettings = saveSettings;
    this.onSettingsChanged = onSettingsChanged;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // Display heading
    new Setting(containerEl)
      .setName('Display')
      .setHeading();

    // Theme mode
    new Setting(containerEl)
      .setName('Theme mode')
      .setDesc('Force light or dark theme, or follow Obsidian.')
      .addDropdown((dropdown) => {
        dropdown
          .addOption('auto', 'Auto')
          .addOption('light', 'Light')
          .addOption('dark', 'Dark')
          .setValue(this.plugin.settings.themeMode)
          .onChange(async (value) => {
            this.plugin.settings.themeMode = value as ThemeMode;
            await this.saveSettings();
            this.onSettingsChanged();
          });
      });

    // Page size
    new Setting(containerEl)
      .setName('Default page size')
      .setDesc('Number of rows per page for new folders.')
      .addDropdown((dropdown) => {
        dropdown
          .addOption('25', '25')
          .addOption('50', '50')
          .addOption('100', '100')
          .setValue(String(this.plugin.settings.pageSize))
          .onChange(async (value) => {
            this.plugin.settings.pageSize = parseInt(value, 10);
            await this.saveSettings();
            this.onSettingsChanged();
          });
      });

    // Max row height
    new Setting(containerEl)
      .setName('Maximum row height')
      .setDesc('Pixel height limit for table rows. Leave empty for unlimited.')
      .addText((text) => {
        text
          .setPlaceholder('Unlimited')
          .setValue(
            this.plugin.settings.maxRowHeight !== null
              ? String(this.plugin.settings.maxRowHeight)
              : ''
          )
          .onChange(async (value) => {
            const trimmed = value.trim();
            if (trimmed === '') {
              this.plugin.settings.maxRowHeight = null;
            } else {
              const parsed = parseInt(trimmed, 10);
              if (!isNaN(parsed) && parsed > 0) {
                this.plugin.settings.maxRowHeight = parsed;
              }
            }
            await this.saveSettings();
            this.onSettingsChanged();
          });
      });

    // Date format
    new Setting(containerEl)
      .setName('Date format')
      .setDesc('How dates are displayed in the table.')
      .addDropdown((dropdown) => {
        for (const fmt of DATE_FORMATS) {
          dropdown.addOption(fmt, fmt);
        }
        dropdown
          .setValue(this.plugin.settings.dateFormat)
          .onChange(async (value) => {
            this.plugin.settings.dateFormat = value as DateFormat;
            await this.saveSettings();
            this.onSettingsChanged();
          });
      });

    // Pill colors heading
    new Setting(containerEl)
      .setName('Pill colors')
      .setHeading();

    // Existing color mappings
    const entries = Object.entries(this.plugin.settings.pillColors);
    for (const [value, color] of entries) {
      new Setting(containerEl)
        .setName(value)
        .addDropdown((dropdown) => {
          for (const c of PILL_COLORS) {
            dropdown.addOption(c, c);
          }
          dropdown
            .setValue(color)
            .onChange(async (newColor) => {
              this.plugin.settings.pillColors[value] = newColor as PillColor;
              await this.saveSettings();
              this.onSettingsChanged();
            });
        })
        .addExtraButton((btn) => {
          btn
            .setIcon('trash')
            .setTooltip('Remove color mapping')
            .onClick(async () => {
              delete this.plugin.settings.pillColors[value];
              await this.saveSettings();
              this.onSettingsChanged();
              this.display();
            });
        });
    }

    // Add new color mapping
    let newValue = '';
    let newColor: PillColor = 'gray';

    const addSetting = new Setting(containerEl)
      .setName('Add color mapping')
      .addText((text) => {
        text
          .setPlaceholder('Tag or theme value')
          .onChange((value) => {
            newValue = value.trim();
          });
      })
      .addDropdown((dropdown) => {
        for (const c of PILL_COLORS) {
          dropdown.addOption(c, c);
        }
        dropdown
          .setValue(newColor)
          .onChange((value) => {
            newColor = value as PillColor;
          });
      });

    addSetting.addExtraButton((btn) => {
      btn
        .setIcon('plus')
        .setTooltip('Add color mapping')
        .onClick(async () => {
          if (newValue === '') return;
          this.plugin.settings.pillColors[newValue] = newColor;
          await this.saveSettings();
          this.onSettingsChanged();
          this.display();
        });
    });
  }
}
