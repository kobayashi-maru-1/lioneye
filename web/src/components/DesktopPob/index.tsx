import { linkBuildFileAtom, pobAtom, pobFileSelector } from "../../state/pob";
import {
  type PobEditor,
  type PobHome,
  POB_EDITORS,
  editBuildFile,
  editorInstalled,
  pobHome,
  saveBuildFile,
} from "../../state/pob/file";
import { pobCodeToXml } from "../../state/pob/process";
import { pobEditorAtom } from "../../state/settings-tab";
import { formStyles } from "../../styles";
import { Modal } from "../Modal";
import { PanelSelect } from "../PanelSelect";
import styles from "./styles.module.css";
import classNames from "classnames";
import { atom, useAtom, useAtomValue, useSetAtom } from "jotai";
import { useEffect, useState } from "react";
import { toast } from "react-toastify";

/**
 * A pasted build being saved to PoB (Desktop PoB's or Save's): the other holds off, so the
 * build isn't saved twice.
 */
const savingAtom = atom(false);

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

/** Path of Building on this PC (null until the exe answers, or without an exe). */
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

/** The chosen editor (anything stored that isn't Redux reads as PoB Community). */
export function usePobEditor() {
  const [stored, setEditor] = useAtom(pobEditorAtom);
  const editor: PobEditor = stored === "redux" ? "redux" : "community";
  return [editor, setEditor] as const;
}

/**
 * Settings' Editor: which PoB Edit and Desktop PoB open. Shows with the exe; "Not
 * installed" under it when the chosen one isn't on this PC (then neither button shows).
 */
export function PobEditorSelect() {
  const home = usePobHome();
  const [editor, setEditor] = usePobEditor();
  if (home === null) return null;
  const installed = editorInstalled(home, editor);
  return (
    <div className={classNames(formStyles.formRow)}>
      <label>Editor</label>
      <div>
        <PanelSelect
          label="Editor"
          describedBy={installed ? undefined : "pob-editor-note"}
          options={POB_EDITORS.map((option) => option.label)}
          value={Math.max(
            0,
            POB_EDITORS.findIndex((option) => option.value === editor),
          )}
          onChange={(i) => setEditor(POB_EDITORS[i].value)}
        />
      </div>
      {!installed && (
        <span id="pob-editor-note" className={classNames(styles.note)}>
          Not installed
        </span>
      )}
    </div>
  );
}

interface DesktopPobProps {
  className: string;
  /** Extra reason to disable it (the form is busy). */
  disabled?: boolean;
  /** Told while it saves or opens, so the form can hold its other buttons. */
  onBusy?: (busy: boolean) => void;
}

/**
 * Opens the build in the chosen PoB (Settings' Editor: PoB Community or PoB Redux): its
 * linked file, or for a pasted build a new file in that PoB's builds folder first ("Save
 * to PoB?"), which the guide then follows. Shows only with that PoB installed and a build
 * loaded.
 */
export function DesktopPob({
  className,
  disabled = false,
  onBusy,
  children,
}: React.PropsWithChildren<DesktopPobProps>) {
  const home = usePobHome();
  const [editor] = usePobEditor();
  const code = useAtomValue(pobAtom);
  const file = useAtomValue(pobFileSelector);
  const linkFile = useSetAtom(linkBuildFileAtom);
  const [busy, setOwnBusy] = useState(false);
  const setBusy = (on: boolean) => {
    setOwnBusy(on);
    onBusy?.(on);
  };
  const [saving, setSaving] = useAtom(savingAtom);
  /** The name a pasted build gets as a PoB file, while "Save to PoB?" is open. */
  const [saveName, setSaveName] = useState<string | null>(null);

  if (!editorInstalled(home, editor) || code === null) return null;
  const editorLabel =
    POB_EDITORS.find((option) => option.value === editor)?.label ?? "PoB";

  const open = async () => {
    if (file === null) {
      setSaveName(defaultName(code));
      return;
    }
    setBusy(true);
    try {
      await editBuildFile(file, editor);
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
    setSaving(true);
    try {
      const path = await saveBuildFile(saveName, pobCodeToXml(code), editor);
      // Only if the same build is still loaded (not unloaded or replaced meanwhile).
      if (!linkFile(path, code)) {
        toast.info("Saved to PoB");
        return;
      }
      await editBuildFile(path, editor);
      toast.info("Saved. PoB opening");
    } catch (error) {
      toast.error(errorMessage(error, "Not saved"));
    } finally {
      setBusy(false);
      setSaving(false);
    }
  };

  return (
    <>
      <button
        className={className}
        title={`Open in ${editorLabel}`}
        disabled={disabled || busy || saving}
        onClick={open}
      >
        {children}
      </button>
      <SaveNameModal
        id="pob-save-name"
        name={saveName}
        onChange={setSaveName}
        onSave={saveAndOpen}
      />
    </>
  );
}

/** "Save to PoB?" with the new file's name; `name` null: closed. */
function SaveNameModal({
  id,
  name,
  onChange,
  onSave,
}: {
  id: string;
  name: string | null;
  onChange: (name: string | null) => void;
  onSave: () => void;
}) {
  return (
    <Modal
      size="small"
      isOpen={name !== null}
      onRequestClose={() => onChange(null)}
      contentLabel="Save to PoB?"
    >
      <form
        className={classNames(formStyles.form)}
        onSubmit={(event) => {
          event.preventDefault();
          onSave();
        }}
      >
        <div className={classNames(formStyles.formRow)}>
          <label htmlFor={id}>Save to PoB?</label>
        </div>
        <p>New file in PoB's builds folder.</p>
        <input
          id={id}
          className={classNames(formStyles.formInput)}
          aria-label="Name"
          value={name ?? ""}
          autoFocus
          maxLength={80}
          onChange={(event) => onChange(event.target.value)}
        />
        <div className={classNames(formStyles.groupRight)}>
          <button
            type="button"
            className={classNames(formStyles.formButton)}
            onClick={() => onChange(null)}
          >
            Cancel
          </button>
          <button
            type="submit"
            className={classNames(formStyles.formButton)}
            disabled={(name ?? "").trim() === ""}
          >
            Save
          </button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * Saves a pasted build as a new file in the chosen PoB's builds folder, without opening
 * PoB; the guide then follows the file. Shows only for a pasted build (no file yet) with
 * that PoB installed.
 */
export function SaveToPob({
  className,
  children,
}: React.PropsWithChildren<{ className: string }>) {
  const home = usePobHome();
  const [editor] = usePobEditor();
  const code = useAtomValue(pobAtom);
  const file = useAtomValue(pobFileSelector);
  const linkFile = useSetAtom(linkBuildFileAtom);
  const [busy, setBusy] = useAtom(savingAtom);
  const [saveName, setSaveName] = useState<string | null>(null);

  if (!editorInstalled(home, editor) || code === null || file !== null)
    return null;

  const save = async () => {
    if (saveName === null) return;
    setSaveName(null);
    setBusy(true);
    try {
      const path = await saveBuildFile(saveName, pobCodeToXml(code), editor);
      // Linked only if the same build is still loaded (not unloaded or replaced meanwhile);
      // saved either way.
      linkFile(path, code);
      toast.success("Saved to PoB");
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
        title="Save to PoB"
        aria-label="Save to PoB"
        disabled={busy}
        onClick={() => setSaveName(defaultName(code))}
      >
        {children}
      </button>
      <SaveNameModal
        id="pob-save-only-name"
        name={saveName}
        onChange={setSaveName}
        onSave={save}
      />
    </>
  );
}
