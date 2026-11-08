import {
  loadBuildAtom,
  pobAtom,
  pobFileSelector,
  unloadBuildAtom,
} from "../../state/pob";
import { openBuildFile, xmlToPobCode } from "../../state/pob/file";
import { processPob } from "../../state/pob/process";
import { formStyles } from "../../styles";
import { fetchStringOrUrl, getRewriteUrl } from "../../utility";
import { URL_REWRITERS } from "../BuildImportForm";
import { DesktopPob, errorMessage, usePobHome } from "../DesktopPob";
import { Modal } from "../Modal";
import styles from "./styles.module.css";
import classNames from "classnames";
import { useAtomValue, useSetAtom } from "jotai";
import { useEffect, useState } from "react";
import { toast } from "react-toastify";

/** True when PoB's code reads as a build. */
function readable(code: string) {
  try {
    return processPob(code) !== null;
  } catch {
    return false;
  }
}

/**
 * The build: paste a PoB code or a pobb.in, poe.ninja, pastebin or maxroll link and
 * Import it, or Open a build file PoB saved (then each save in PoB updates the guide).
 * Edit opens the build in the PoB chosen under Editor, when it's installed
 * (components/DesktopPob).
 * Loading a build keeps your progress; Unload removes it.
 */
export function BuildCodeForm() {
  const code = useAtomValue(pobAtom);
  const file = useAtomValue(pobFileSelector);
  const loadBuild = useSetAtom(loadBuildAtom);
  const unload = useSetAtom(unloadBuildAtom);
  // Empty, with the loaded code as its placeholder: paste a new one without clearing it.
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [importing, setImporting] = useState(false);
  const [confirmUnload, setConfirmUnload] = useState(false);
  const home = usePobHome();
  // A new build loaded (or unloaded): its code shows as the placeholder. What you were
  // typing stays (a save in PoB refreshes the code too).
  useEffect(() => {
    setError(null);
  }, [code]);

  const loaded = (code ?? "").trim();
  // Anything pasted: Import says "Already loaded" for the loaded build itself.
  const changed = text.trim() !== "";

  const importCode = async () => {
    const input = text.trim();
    const isLink = getRewriteUrl(input, URL_REWRITERS) !== null;
    setBusy(true);
    setImporting(true);
    setError(null);
    try {
      const value = (await fetchStringOrUrl(input, URL_REWRITERS)).trim();
      if (!readable(value)) {
        setError("Code not read. Paste a PoB code or link.");
      } else if (value === loaded) {
        setText("");
        toast.info("Already loaded");
      } else if (loadBuild(value, null)) {
        setText("");
        toast.success("Build imported");
      }
    } catch {
      setError(
        isLink
          ? "Link not loaded. Check it and retry."
          : "Code not read. Paste a PoB code or link.",
      );
    } finally {
      setBusy(false);
      setImporting(false);
    }
  };

  const openFile = async () => {
    setBusy(true);
    setError(null);
    try {
      const chosen = await openBuildFile();
      if (chosen === null) return;
      if (loadBuild(xmlToPobCode(chosen.xml), chosen.path))
        toast.success("Build opened");
      else setError("Not a PoB build. Open another file.");
    } catch (error) {
      setError(errorMessage(error, "Open failed"));
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      toast.success("PoB copied");
    } catch {
      toast.error("Copy failed. Try again.");
    }
  };

  return (
    <div className={classNames(formStyles.formRow)}>
      <label htmlFor="pob-code">PoB code</label>
      <textarea
        id="pob-code"
        className={classNames(formStyles.formInput, styles.code, {
          [styles.loaded]: code !== null,
        })}
        spellCheck={false}
        placeholder={code ?? "PoB code or link"}
        value={text}
        aria-invalid={error !== null}
        aria-describedby={error ? "pob-code-error" : undefined}
        onChange={(event) => {
          setText(event.target.value);
          setError(null);
        }}
      />
      {file !== null && code !== null && (
        <div className={classNames(styles.file)}>
          <span className={classNames(styles.fileLabel)}>File</span>
          <span className={classNames(styles.fileName)}>{file}</span>
        </div>
      )}
      {error && (
        <span
          id="pob-code-error"
          role="alert"
          className={classNames(styles.error)}
        >
          {error}
        </span>
      )}
      <div className={classNames(formStyles.groupRight, styles.buttons)}>
        <button
          className={classNames(formStyles.formButton)}
          disabled={code === null || busy}
          onClick={() => setConfirmUnload(true)}
        >
          Unload
        </button>
        <button
          className={classNames(formStyles.formButton)}
          disabled={code === null}
          onClick={copy}
        >
          Copy
        </button>
        {home !== null && (
          <button
            className={classNames(formStyles.formButton)}
            disabled={busy}
            onClick={openFile}
          >
            Open
          </button>
        )}
        <DesktopPob
          className={classNames(formStyles.formButton)}
          disabled={busy}
          onBusy={setBusy}
        >
          Edit
        </DesktopPob>
        <button
          className={classNames(formStyles.formButton)}
          disabled={!changed || busy}
          onClick={importCode}
        >
          {importing ? "Importing…" : "Import"}
        </button>
      </div>
      <Modal
        size="small"
        isOpen={confirmUnload}
        onRequestClose={() => setConfirmUnload(false)}
        contentLabel="Unload build?"
      >
        <div className={classNames(formStyles.form)}>
          <div className={classNames(formStyles.formRow)}>
            <label>Unload build?</label>
          </div>
          <p>Progress stays.</p>
          <div className={classNames(formStyles.groupRight)}>
            <button
              className={classNames(formStyles.formButton)}
              autoFocus
              onClick={() => setConfirmUnload(false)}
            >
              Cancel
            </button>
            <button
              className={classNames(formStyles.formButton)}
              onClick={() => {
                setConfirmUnload(false);
                unload();
                toast.success("Build unloaded");
              }}
            >
              Unload
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
