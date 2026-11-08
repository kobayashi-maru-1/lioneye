import { linkBuildFileAtom, pobAtom, pobFileSelector } from "../../state/pob";
import {
  type PobHome,
  editBuildFile,
  pobHome,
  saveBuildFile,
} from "../../state/pob/file";
import { pobCodeToXml } from "../../state/pob/process";
import { formStyles } from "../../styles";
import { Modal } from "../Modal";
import classNames from "classnames";
import { useAtomValue, useSetAtom } from "jotai";
import { useEffect, useState } from "react";
import { toast } from "react-toastify";

/** What an error says, ready to show; `failed` ("Not saved") when it says nothing. */
export function errorMessage(error: unknown, failed: string) {
  return error instanceof Error && error.message
    ? error.message
    : `${failed}. Retry.`;
}

/** A name for a pasted build saved to PoB: its ascendancy (else class). */
function defaultName(code: string) {
  try {
    const build = new DOMParser()
      .parseFromString(pobCodeToXml(code), "application/xml")
      .getElementsByTagName("Build")[0];
    const ascendancy = build?.getAttribute("ascendClassName");
    const name =
      ascendancy && ascendancy !== "None"
        ? ascendancy
        : build?.getAttribute("className");
    return name ? `${name} build` : "Lioneye build";
  } catch {
    return "Lioneye build";
  }
}

/** PoB Community on this PC (null until the exe answers, or without an exe). */
export function usePobHome() {
  const [home, setHome] = useState<PobHome | null>(null);
  useEffect(() => {
    let live = true;
    pobHome().then((found) => live && setHome(found));
    return () => {
      live = false;
    };
  }, []);
  return home;
}

interface DesktopPobProps {
  className: string;
  /** Extra reason to disable it (the form is busy). */
  disabled?: boolean;
  /** Told while it saves or opens, so the form can hold its other buttons. */
  onBusy?: (busy: boolean) => void;
}

/**
 * Opens the build in PoB Community on this PC: its linked file, or for a pasted build a
 * new file in PoB's builds folder first ("Save to PoB?"), which the guide then follows.
 * Shows only with PoB Community installed and a build loaded.
 */
export function DesktopPob({
  className,
  disabled = false,
  onBusy,
  children,
}: React.PropsWithChildren<DesktopPobProps>) {
  const home = usePobHome();
  const code = useAtomValue(pobAtom);
  const file = useAtomValue(pobFileSelector);
  const linkFile = useSetAtom(linkBuildFileAtom);
  const [busy, setOwnBusy] = useState(false);
  const setBusy = (on: boolean) => {
    setOwnBusy(on);
    onBusy?.(on);
  };
  /** The name a pasted build gets as a PoB file, while "Save to PoB?" is open. */
  const [saveName, setSaveName] = useState<string | null>(null);

  if (!home?.installed || code === null) return null;

  const open = async () => {
    if (file === null) {
      setSaveName(defaultName(code));
      return;
    }
    setBusy(true);
    try {
      await editBuildFile(file);
      toast.info("PoB opening");
    } catch (error) {
      toast.error(errorMessage(error, "PoB not opened"));
    } finally {
      setBusy(false);
    }
  };

  const saveAndOpen = async () => {
    if (saveName === null) return;
    setSaveName(null);
    setBusy(true);
    try {
      const path = await saveBuildFile(saveName, pobCodeToXml(code));
      // Only if the same build is still loaded (not unloaded or replaced meanwhile).
      if (!linkFile(path, code)) return;
      await editBuildFile(path);
      toast.info("Saved. PoB opening");
    } catch (error) {
      toast.error(errorMessage(error, "Not saved"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        className={className}
        title="Open in PoB"
        disabled={disabled || busy}
        onClick={open}
      >
        {children}
      </button>
      <Modal
        size="small"
        isOpen={saveName !== null}
        onRequestClose={() => setSaveName(null)}
        contentLabel="Save to PoB?"
      >
        <form
          className={classNames(formStyles.form)}
          onSubmit={(event) => {
            event.preventDefault();
            saveAndOpen();
          }}
        >
          <div className={classNames(formStyles.formRow)}>
            <label htmlFor="pob-save-name">Save to PoB?</label>
          </div>
          <p>New file in PoB's builds folder.</p>
          <input
            id="pob-save-name"
            className={classNames(formStyles.formInput)}
            aria-label="Name"
            value={saveName ?? ""}
            autoFocus
            maxLength={80}
            onChange={(event) => setSaveName(event.target.value)}
          />
          <div className={classNames(formStyles.groupRight)}>
            <button
              type="button"
              className={classNames(formStyles.formButton)}
              onClick={() => setSaveName(null)}
            >
              Cancel
            </button>
            <button
              type="submit"
              className={classNames(formStyles.formButton)}
              disabled={(saveName ?? "").trim() === ""}
            >
              Save
            </button>
          </div>
        </form>
      </Modal>
    </>
  );
}
