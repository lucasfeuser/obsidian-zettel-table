import { Plugin } from 'obsidian';
import { ZettelTableSettings, DEFAULT_SETTINGS } from './types';
import { DataLayer } from './data';
import { ZettelTableView, VIEW_TYPE_ZETTEL_TABLE } from './view';
import { ZettelTableSettingTab } from './settings';

export default class ZettelTablePlugin extends Plugin {
  settings: ZettelTableSettings = DEFAULT_SETTINGS;

  async onload(): Promise<void> {
    await this.loadSettings();

    const dataLayer = new DataLayer(this.app);
    this.addChild(dataLayer);
    dataLayer.registerEvents();

    this.registerView(VIEW_TYPE_ZETTEL_TABLE, (leaf) => {
      return new ZettelTableView(leaf, dataLayer, this.settings, () => this.saveSettings());
    });

    this.addCommand({
      id: 'open-view',
      name: 'Open zettel table',
      callback: () => {
        this.activateView();
      },
    });

    this.addSettingTab(
      new ZettelTableSettingTab(
        this.app,
        this,
        () => this.saveSettings(),
        () => this.refreshViews()
      )
    );
  }

  onunload(): void {
    // registerEvent/register/addChild handle cleanup
  }

  async activateView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_ZETTEL_TABLE);
    if (existing.length > 0) {
      this.app.workspace.revealLeaf(existing[0]);
      return;
    }

    const leaf = this.app.workspace.getLeaf(false);
    if (leaf) {
      await leaf.setViewState({
        type: VIEW_TYPE_ZETTEL_TABLE,
        active: true,
      });
      this.app.workspace.revealLeaf(leaf);
    }
  }

  private async loadSettings(): Promise<void> {
    const data = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  private refreshViews(): void {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_ZETTEL_TABLE);
    for (const leaf of leaves) {
      const view = leaf.view;
      if (view instanceof ZettelTableView) {
        view.refreshSettings(this.settings);
      }
    }
  }
}
