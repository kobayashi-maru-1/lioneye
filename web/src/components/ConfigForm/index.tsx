import type { Config } from "../../state/config";
import { SwitchRow } from "../SettingsCard";

interface ConfigFormProps {
  config: Config;
  onSubmit: (config: Config) => void;
}

/** Settings → Route: Gems only, and All hints (every step's sub-steps). */
export function ConfigForm({ config, onSubmit }: ConfigFormProps) {
  return (
    <>
      <SwitchRow
        label="Gems only"
        checked={config.gemsOnly}
        onChange={(gemsOnly) => onSubmit({ ...config, gemsOnly })}
      />
      <SwitchRow
        label="All hints"
        checked={config.showSubsteps}
        onChange={(showSubsteps) => onSubmit({ ...config, showSubsteps })}
      />
    </>
  );
}
