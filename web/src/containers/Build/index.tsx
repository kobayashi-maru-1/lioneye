import { useAtom, useSetAtom } from "jotai";
import { AppSettingsForm } from "../../components/AppSettingsForm";
import { BuildImportForm } from "../../components/BuildImportForm";
import { BuildInfoForm } from "../../components/BuildInfoForm";
import { ConfigForm } from "../../components/ConfigForm";
import { GemEditForm } from "../../components/GemEditForm";
import { Modal } from "../../components/Modal";
import { OverlayForm } from "../../components/OverlayForm";
import { STATS_AVAILABLE } from "../../components/PobStats";
import { SearchStringsEditor } from "../../components/SearchStringsEditor";
import { buildDataSelector } from "../../state/build-data";
import { configSelector } from "../../state/config";
import { requiredGemsSelector } from "../../state/gem";
import { formStyles } from "../../styles";
import classNames from "classnames";
import { RESET, useAtomCallback } from "jotai/utils";
import { pobAtom } from "../../state/pob";
import { routeSelector } from "../../state/route";
import { useCallback, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "react-toastify";

export default function BuildContainer() {
  const [config, setConfig] = useAtom(configSelector);
  const [buildData, setBuildData] = useAtom(buildDataSelector);
  const [requiredGems, setRequiredGems] = useAtom(requiredGemsSelector);
  const setPob = useSetAtom(pobAtom);
  // Reset wipes the build and route progress: asked first.
  const [confirmReset, setConfirmReset] = useState(false);

  return (
    <div>
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
      <hr />
      <div className={classNames(formStyles.form)}>
        <SearchStringsEditor />
        <BuildImportForm
          onSubmit={(pobCode) => {
            setPob(pobCode);
          }}
          onReset={() => setConfirmReset(true)}
        />
      </div>
      <hr />
      {requiredGems.length > 0 && (
        <>
          <GemEditForm
            requiredGems={requiredGems}
            onUpdate={(requiredGems) => {
              setRequiredGems(requiredGems);
            }}
          />
          <hr />
        </>
      )}
      {/* The in-game bar, the game log and the browser exist only with the exe. */}
      {STATS_AVAILABLE && (
        <>
          <OverlayForm />
          <hr />
          <AppSettingsForm />
          <hr />
        </>
      )}
      <RouteSettings />
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
function RouteSettings() {
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
      <div className={classNames(formStyles.formRow)}>
        <label>Route</label>
      </div>
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
