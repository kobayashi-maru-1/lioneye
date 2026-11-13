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
 * Imports a pasted PoB code or build link, the way Settings' Import code does: fetches a
 * link, checks the code reads as a build, loads it (your progress stays). `importCode`
 * resolves true when the text is now the loaded build (imported, or already loaded).
 */
export function useImportCode() {
  const code = useAtomValue(pobAtom);
  const loadBuild = useSetAtom(loadBuildAtom);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);

  const importCode = async (text: string) => {
    const input = text.trim();
    const isLink = getRewriteUrl(input, URL_REWRITERS) !== null;
    setImporting(true);
    setError(null);
    try {
      const value = (await fetchStringOrUrl(input, URL_REWRITERS)).trim();
      if (!readable(value)) {
        setError("Code not read. Paste a PoB code or link.");
      } else if (value === (code ?? "").trim()) {
        toast.info("Already loaded");
        return true;
      } else if (loadBuild(value, null)) {
        toast.success("Build imported");
        return true;
      } else {
        setError("Code not read. Paste a PoB code or link.");
      }
    } catch {
      setError(
        isLink
          ? "Link not loaded. Check it and retry."
          : "Code not read. Paste a PoB code or link.",
      );
    } finally {
      setImporting(false);
    }
    return false;
  };

  return { importCode, importing, error, setError };
}

/**
 * The guide's Load button (beside Save at the top): a popup to paste a PoB code or build
 * link and import it, without leaving the guide.
 */
export function LoadCode({
  className,
  children,
}: React.PropsWithChildren<{ className: string }>) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const { importCode, importing, error, setError } = useImportCode();
  const id = useId();
  const close = () => {
    setOpen(false);
    setText("");
    setError(null);
  };

  return (
    <>
      <button
        className={className}
        title="Load code"
        aria-label="Load code"
        onClick={() => setOpen(true)}
      >
        {children}
      </button>
      <Modal
        size="medium"
        isOpen={open}
        onRequestClose={close}
        contentLabel="Load build"
      >
        <form
          className={classNames(formStyles.form, styles.loadForm)}
          onSubmit={async (event) => {
            event.preventDefault();
            if (text.trim() === "" || importing) return;
            if (await importCode(text)) close();
          }}
        >
          <div className={classNames(formStyles.formRow)}>
            <label htmlFor={id}>Load build</label>
          </div>
          <textarea
            id={id}
            className={classNames(formStyles.formInput, styles.loadCode)}
            spellCheck={false}
            autoFocus
            placeholder="PoB code or link"
            value={text}
            aria-invalid={error !== null}
            aria-describedby={error ? `${id}-error` : undefined}
            onChange={(event) => {
              setText(event.target.value);
              setError(null);
            }}
          />
          {error && (
            <div
              id={`${id}-error`}
              role="alert"
              className={classNames(styles.error)}
            >
              {error}
            </div>
          )}
          <div className={classNames(formStyles.groupRight)}>
            <button
              type="button"
              className={classNames(formStyles.formButton)}
              onClick={close}
            >
              Cancel
            </button>
            <button
              type="submit"
              className={classNames(formStyles.formButton)}
              disabled={text.trim() === "" || importing}
            >
              {importing ? "Importing…" : "Import"}
            </button>
          </div>
        </form>
      </Modal>
    </>
  );
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
  const {
    importCode: importText,
    importing,
    error,
    setError,
  } = useImportCode();
  const [busy, setBusy] = useState(false);
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

  // Anything pasted: Import says "Already loaded" for the loaded build itself.
  const changed = text.trim() !== "";

  const importCode = async () => {
    setBusy(true);
    try {
      if (await importText(text)) setText("");
    } finally {
      setBusy(false);
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
