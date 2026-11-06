import { useAppInfo, type ExeSettings } from "../../state/app-info";
import { autoProgressAtom } from "../../state/auto-progress";
import { formStyles } from "../../styles";
import { PanelSelect } from "../PanelSelect";
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
 * The exe's own settings: which Client.txt it follows (found from the running game unless
 * set) and which browser opens the guide. A command-line --log-path or --browser wins.
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
    <div className={classNames(formStyles.form)}>
      <div className={classNames(formStyles.formRow)}>
        <label htmlFor="game-log">Game log</label>
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
        <span className={classNames(styles.note)}>
          {logLocked
            ? "Set by --log-path"
            : status.kind === "watching"
              ? `Following ${status.path}`
              : status.kind === "waiting"
                ? "Waiting for the game"
                : "App offline"}
        </span>
        {error && <span className={classNames(styles.error)}>{error}</span>}
      </div>
      <div className={classNames(formStyles.formRow)}>
        <label>Browser</label>
        <div className={classNames(styles.line)}>
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
        </div>
        <span className={classNames(styles.note)}>
          {browserLocked
            ? "Set by --browser"
            : "Applies when the guide next opens"}
        </span>
      </div>
    </div>
  );
}
