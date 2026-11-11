import { OVERLAY_PANELS, overlaySettingsAtom } from "../../state/overlay";
import { CheckGrid, SettingRow, SwitchRow } from "../SettingsCard";
import { useAtom } from "jotai";
import { useId } from "react";

/**
 * Settings → App → Overlay (the rows; the card is Settings'): whether the in-game bar
 * shows over the game, whether its Tree tooltip opens with the game's passive tree, and
 * which panels get a button. Panels the build doesn't have are left off the bar.
 */
export function OverlayForm() {
  const [settings, setSettings] = useAtom(overlaySettingsAtom);
  const buttonsId = useId();

  const toggle = (id: string, checked: boolean) =>
    setSettings({
      ...settings,
      panels: checked
        ? [...settings.panels.filter((panel) => panel !== id), id]
        : settings.panels.filter((panel) => panel !== id),
    });

  return (
    <>
      <SwitchRow
        label="Show in game"
        checked={settings.on}
        onChange={(on) => setSettings({ ...settings, on })}
      />
      <SwitchRow
        label="Auto tree"
        title="Tree tooltip opens with the game's tree"
        checked={settings.autoTree !== false}
        disabled={!settings.on}
        onChange={(autoTree) => setSettings({ ...settings, autoTree })}
      />
      <SettingRow label="Buttons" labelId={buttonsId}>
        <CheckGrid
          labelledBy={buttonsId}
          disabled={!settings.on}
          items={OVERLAY_PANELS.map((panel) => ({
            id: panel.id,
            label: panel.label,
            checked: settings.panels.includes(panel.id),
          }))}
          onChange={toggle}
        />
      </SettingRow>
    </>
  );
}
