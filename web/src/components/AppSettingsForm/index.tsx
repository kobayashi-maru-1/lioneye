import { useAppInfo, type ExeSettings } from "../../state/app-info";
import { autoProgressAtom } from "../../state/auto-progress";
import { formStyles } from "../../styles";
import { PanelSelect } from "../PanelSelect";
import { SettingRow, SettingsCard } from "../SettingsCard";
import styles from "./styles.module.css";
import classNames from "classnames";
import { useAtomValue } from "jotai";
import { useEffect, useState } from "react";

const BROWSERS: { value: ExeSettings["browser"]; label: string }[] = [
  { value: "app", label: "Own window" },
  { value: "edge", label: "Edge profile" },
  { value: "default", label: "Default browser" },
];

/**
 * Settings → App → Game, the exe's own settings: which Client.txt it follows (found from
 * the running game unless set) and which browser opens the guide. A command-line
 * --log-path or --browser wins. The whole card; nothing without the exe.
 */
export function AppSettingsForm() {
  const { info, update } = useAppInfo();
  const status = useAtomValue(autoProgressAtom);
  const settings = info?.settings ?? null;
  const [logPath, setLogPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (settings) setLogPath(settings.logPath ?? "");
  }, [settings?.logPath]);

  if (settings === null) return null;
  const logLocked = settings.logFromCommandLine !== null;
  const browserLocked = settings.browserFromCommandLine !== null;

  const save = async (change: Parameters<typeof update>[0]) => {
    setSaving(true);
    setError(await update(change));
    setSaving(false);
  };

  return (
    <SettingsCard title="Game">
      <SettingRow label="Game log" htmlFor="game-log">
        <div className={classNames(styles.line)}>
          <input
            id="game-log"
            className={classNames(formStyles.formInput, styles.path)}
            spellCheck={false}
            placeholder="Found from the running game"
            value={logLocked ? (settings.logFromCommandLine ?? "") : logPath}
            disabled={logLocked || saving}
            onChange={(event) => setLogPath(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") save({ logPath });
            }}
          />
          <button
            className={classNames(formStyles.formButton)}
            disabled={
              logLocked || saving || logPath === (settings.logPath ?? "")
            }
            onClick={() => save({ logPath })}
          >
            Save
          </button>
        </div>
        <div className={classNames(styles.note)}>
          {logLocked
            ? "Set by --log-path"
            : status.kind === "watching"
              ? `Following ${status.path}`
              : status.kind === "waiting"
                ? "Waiting for the game"
                : "App offline"}
        </div>
        {error && <div className={classNames(styles.error)}>{error}</div>}
      </SettingRow>
      <SettingRow label="Browser">
        {browserLocked ? (
          <span>{settings.browserFromCommandLine}</span>
        ) : (
          <PanelSelect
            label="Browser"
            options={BROWSERS.map((browser) => browser.label)}
            value={Math.max(
              0,
              BROWSERS.findIndex(
                (browser) =>
                  browser.value ===
                  (settings.browserFromCommandLine ?? settings.browser),
              ),
            )}
            onChange={(i) => save({ browser: BROWSERS[i].value })}
          />
        )}
        <div className={classNames(styles.note)}>
          {browserLocked
            ? "Set by --browser"
            : "Applies when the guide next opens"}
        </div>
      </SettingRow>
    </SettingsCard>
  );
}
