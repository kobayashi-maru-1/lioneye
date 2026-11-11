import { SettingRow, SwitchRow } from "../SettingsCard";
import type { RouteData } from "common";

interface BuildInfoFormProps {
  buildData: RouteData.BuildData;
  onSubmit: (buildData: RouteData.BuildData) => void;
}

/** Settings → Route: the build's class and bandit (from PoB), League start and Library. */
export function BuildInfoForm({ buildData, onSubmit }: BuildInfoFormProps) {
  return (
    <>
      <SettingRow label="Class" inline>
        {buildData.characterClass}
      </SettingRow>
      <SettingRow label="Bandits" inline>
        {buildData.bandit == "None" ? "Kill all" : buildData.bandit}
      </SettingRow>
      <SwitchRow
        label="League start"
        checked={buildData.leagueStart}
        onChange={(leagueStart) => onSubmit({ ...buildData, leagueStart })}
      />
      <SwitchRow
        label="Library"
        checked={buildData.library}
        onChange={(library) => onSubmit({ ...buildData, library })}
      />
    </>
  );
}
