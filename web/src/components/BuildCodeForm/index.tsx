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
import { SettingRow } from "../SettingsCard";
import styles from "./styles.module.css";
import classNames from "classnames";
import { useAtomValue, useSetAtom } from "jotai";
import { useEffect, useId, useRef, useState } from "react";
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
 * The build. Load: paste a PoB code or a pobb.in, poe.ninja, pastebin or maxroll link and
 * Import code, or Open file for a build file PoB saved (then each save in PoB updates the
 * guide). Loaded: Edit PoB opens the build in the PoB chosen under Editor, when it's
 * installed (components/DesktopPob); Copy code; Clear build (asks first).
 * Loading a build keeps your progress; Clear build removes the build, not the progress.
 * The PoB code row of Settings' Build card.
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
  const [confirmClear, setConfirmClear] = useState(false);
  const home = usePobHome();
  // Unique, should the form ever show twice.
  const loadId = useId();
  const loadedId = useId();
  const codeRef = useRef<HTMLTextAreaElement>(null);
  // A new build loaded (or cleared): its code shows as the placeholder. What you were
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
    <SettingRow label="PoB code" htmlFor="pob-code">
      <textarea
        ref={codeRef}
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
        <div
          id="pob-code-error"
          role="alert"
          className={classNames(styles.error)}
        >
          {error}
        </div>
      )}
      {/* Two groups: bring a build in, and act on the one loaded. */}
      <div className={classNames(styles.actions)}>
        <div
          className={classNames(styles.group)}
          role="group"
          aria-labelledby={loadId}
        >
          <span id={loadId} className={classNames(styles.groupLabel)}>
            Load
          </span>
          <div className={classNames(styles.groupButtons)}>
            <button
              className={classNames(formStyles.formButton)}
              disabled={!changed || busy}
              onClick={importCode}
            >
              {importing ? "Importing…" : "Import code"}
            </button>
            {home !== null && (
              <button
                className={classNames(formStyles.formButton)}
                disabled={busy}
                onClick={openFile}
              >
                Open file
              </button>
            )}
          </div>
        </div>
        {code !== null && (
          <div
            className={classNames(styles.group)}
            role="group"
            aria-labelledby={loadedId}
          >
            <span id={loadedId} className={classNames(styles.groupLabel)}>
              Loaded
            </span>
            <div className={classNames(styles.groupButtons)}>
              {/* Three words: "Edit" alone didn't say it opens Path of Building. */}
              <DesktopPob
                className={classNames(formStyles.formButton)}
                disabled={busy}
                onBusy={setBusy}
              >
                Edit PoB
              </DesktopPob>
              <button
                className={classNames(formStyles.formButton)}
                onClick={copy}
              >
                Copy code
              </button>
              <button
                className={classNames(formStyles.formButton)}
                disabled={busy}
                onClick={() => setConfirmClear(true)}
              >
                Clear build
              </button>
            </div>
          </div>
        )}
      </div>
      <Modal
        size="small"
        isOpen={confirmClear}
        onRequestClose={() => setConfirmClear(false)}
        // After Clear build its button is gone (the Loaded group hides): focus the code box.
        onAfterClose={() => {
          if (
            !document.activeElement ||
            document.activeElement === document.body
          )
            codeRef.current?.focus();
        }}
        contentLabel="Clear build?"
      >
        <div className={classNames(formStyles.form)}>
          <div className={classNames(formStyles.formRow)}>
            <label>Clear build?</label>
          </div>
          <p>Progress stays.</p>
          <div className={classNames(formStyles.groupRight)}>
            <button
              className={classNames(formStyles.formButton)}
              autoFocus
              onClick={() => setConfirmClear(false)}
            >
              Cancel
            </button>
            <button
              className={classNames(formStyles.formButton)}
              onClick={() => {
                setConfirmClear(false);
                unload();
                toast.success("Build cleared");
              }}
            >
              Clear
            </button>
          </div>
        </div>
      </Modal>
    </SettingRow>
  );
}
