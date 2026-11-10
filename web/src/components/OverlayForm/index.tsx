import { OVERLAY_PANELS, overlaySettingsAtom } from "../../state/overlay";
import { formStyles } from "../../styles";
import styles from "./styles.module.css";
import classNames from "classnames";
import { useAtom } from "jotai";

/**
 * Settings for the in-game bar: whether it shows over the game, whether its Tree tooltip
 * opens with the game's passive tree, and which panels get a button. Panels the build
 * doesn't have are left off the bar.
 */
export function OverlayForm() {
  const [settings, setSettings] = useAtom(overlaySettingsAtom);

  const toggle = (id: string, checked: boolean) =>
    setSettings({
      ...settings,
      panels: checked
        ? [...settings.panels.filter((panel) => panel !== id), id]
        : settings.panels.filter((panel) => panel !== id),
    });

  return (
    <div className={classNames(formStyles.form)}>
      <div className={classNames(formStyles.formRow)}>
        <label>Overlay</label>
      </div>
      <label className={classNames(styles.option)}>
        <input
          type="checkbox"
          checked={settings.on}
          onChange={(event) =>
            setSettings({ ...settings, on: event.target.checked })
          }
        />
        Show in game
      </label>
      <label
        className={classNames(styles.option)}
        title="Tree tooltip opens with the game's tree"
      >
        <input
          type="checkbox"
          checked={settings.autoTree !== false}
          disabled={!settings.on}
          onChange={(event) =>
            setSettings({ ...settings, autoTree: event.target.checked })
          }
        />
        Auto tree
      </label>
      <fieldset
        className={classNames(styles.panels)}
        disabled={!settings.on}
        aria-label="Buttons"
      >
        {OVERLAY_PANELS.map((panel) => (
          <label key={panel.id} className={classNames(styles.option)}>
            <input
              type="checkbox"
              checked={settings.panels.includes(panel.id)}
              onChange={(event) => toggle(panel.id, event.target.checked)}
            />
            {panel.label}
          </label>
        ))}
      </fieldset>
    </div>
  );
}
