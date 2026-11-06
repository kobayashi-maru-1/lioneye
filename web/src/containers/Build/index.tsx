import { useAtom, useSetAtom } from "jotai";
import { AppSettingsForm } from "../../components/AppSettingsForm";
import { BuildCodeForm } from "../../components/BuildCodeForm";
import { BuildInfoForm } from "../../components/BuildInfoForm";
import { ConfigForm } from "../../components/ConfigForm";
import { GemEditForm } from "../../components/GemEditForm";
import { Modal } from "../../components/Modal";
import { OverlayForm } from "../../components/OverlayForm";
import { STATS_AVAILABLE } from "../../components/PobStats";
import { SearchStringsEditor } from "../../components/SearchStringsEditor";
import {
  type SettingsTab as Tab,
  gemListOpenAtom,
  settingsTabAtom,
} from "../../state/settings-tab";
import { buildDataSelector } from "../../state/build-data";
import { configSelector } from "../../state/config";
import { requiredGemsSelector } from "../../state/gem";
import { formStyles } from "../../styles";
import styles from "./styles.module.css";
import classNames from "classnames";
import { RESET, useAtomCallback } from "jotai/utils";
import { pobAtom } from "../../state/pob";
import { routeSelector } from "../../state/route";
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "react-toastify";

/**
 * App: the exe's own (first, where Settings opens). Build: your PoB and search strings.
 * Route: what the campaign shows.
 */
const TABS: { id: Tab; label: string }[] = [
  // The in-game bar, the game log and the browser exist only with the exe.
  ...(STATS_AVAILABLE ? [{ id: "app" as Tab, label: "App" }] : []),
  { id: "build", label: "Build" },
  { id: "route", label: "Route" },
];

export default function BuildContainer() {
  const [config, setConfig] = useAtom(configSelector);
  const [buildData, setBuildData] = useAtom(buildDataSelector);
  const [requiredGems, setRequiredGems] = useAtom(requiredGemsSelector);
  const setPob = useSetAtom(pobAtom);
  // Reset wipes the build and route progress: asked first.
  const [confirmReset, setConfirmReset] = useState(false);
  // Opens on the first tab, or the one a link asked for (once).
  const [requested, setRequested] = useAtom(settingsTabAtom);
  const [tab, setTab] = useState<Tab>(() =>
    requested && TABS.some((t) => t.id === requested) ? requested : TABS[0].id,
  );
  useEffect(() => {
    if (requested !== null) setRequested(null);
  }, []);
  const [gemsOpen, setGemsOpen] = useAtom(gemListOpenAtom);

  return (
    <div>
      <div
        className={classNames(styles.tabs)}
        role="tablist"
        aria-label="Settings"
      >
        {TABS.map(({ id, label }) => (
          <button
            key={id}
            role="tab"
            id={`settings-tab-${id}`}
            aria-controls="settings-panel"
            aria-selected={tab === id}
            className={classNames(styles.tab, {
              [styles.active]: tab === id,
            })}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <div
        id="settings-panel"
        role="tabpanel"
        aria-labelledby={`settings-tab-${tab}`}
      >
        {tab === "build" && (
          <div className={classNames(formStyles.form)}>
            <BuildCodeForm
              onImport={(pobCode) => {
                setPob(pobCode);
              }}
              onReset={() => setConfirmReset(true)}
            />
            <SearchStringsEditor />
            <span className={classNames(styles.hint)}>
              A # line names the string below it.
            </span>
          </div>
        )}
        {tab === "route" && (
          <>
            <RouteActions />
            <hr />
            <BuildInfoForm
              buildData={buildData}
              onSubmit={(buildData) => {
                setBuildData(buildData);
              }}
            />
            <hr />
            <ConfigForm
              config={config}
              onSubmit={(config) => {
                setConfig(config);
              }}
            />
            {requiredGems.length > 0 && (
              <>
                <hr />
                {/* Long: open until you fold it, then as you left it. */}
                <details
                  className={classNames(styles.gems)}
                  open={gemsOpen}
                  onToggle={(event) => {
                    const open = event.currentTarget.open;
                    if (open !== gemsOpen) setGemsOpen(open);
                  }}
                >
                  <summary>Gems ({requiredGems.length})</summary>
                  <GemEditForm
                    requiredGems={requiredGems}
                    onUpdate={(requiredGems) => {
                      setRequiredGems(requiredGems);
                    }}
                  />
                </details>
              </>
            )}
          </>
        )}
        {tab === "app" && (
          <>
            <OverlayForm />
            <hr />
            <AppSettingsForm />
          </>
        )}
      </div>
      <Modal
        size="small"
        isOpen={confirmReset}
        onRequestClose={() => setConfirmReset(false)}
        contentLabel="Reset progress?"
      >
        <div className={classNames(formStyles.form)}>
          <div className={classNames(formStyles.formRow)}>
            <label>Reset progress?</label>
          </div>
          <p>Clears the imported build and your route progress.</p>
          <div className={classNames(formStyles.groupRight)}>
            <button
              className={classNames(formStyles.formButton)}
              autoFocus
              onClick={() => setConfirmReset(false)}
            >
              Cancel
            </button>
            <button
              className={classNames(formStyles.formButton)}
              onClick={() => {
                setConfirmReset(false);
                setPob(RESET);
              }}
            >
              Reset
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

/** Route editing and the export for other tools (the old menu bar's). */
function RouteActions() {
  const navigate = useNavigate();
  const exportRoute = useAtomCallback(
    useCallback(async (get) => {
      const route = await get(routeSelector);
      const pobCode = get(pobAtom);
      const output = [...route.sections, `pob-code:${pobCode ?? "none"}`];
      try {
        await navigator.clipboard.writeText(JSON.stringify(output));
        toast.success("Exported to Clipboard");
      } catch {
        toast.error("Export failed. Try again.");
      }
    }, []),
  );

  return (
    <div className={classNames(formStyles.form)}>
      <div className={classNames(formStyles.groupLeft)}>
        <button
          className={classNames(formStyles.formButton)}
          onClick={() => navigate("/edit-route")}
        >
          Edit route
        </button>
        <button
          className={classNames(formStyles.formButton)}
          title="Copy the route and build for other tools"
          onClick={() => exportRoute()}
        >
          Export
        </button>
      </div>
    </div>
  );
}
