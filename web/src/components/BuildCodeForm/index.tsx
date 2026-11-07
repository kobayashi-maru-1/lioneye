import {
  linkBuildFileAtom,
  loadBuildAtom,
  pobAtom,
  pobFileSelector,
  unloadBuildAtom,
} from "../../state/pob";
import {
  type PobHome,
  buildFileName,
  editBuildFile,
  openBuildFile,
  pobHome,
  saveBuildFile,
  xmlToPobCode,
} from "../../state/pob/file";
import { pobCodeToXml, processPob } from "../../state/pob/process";
import { formStyles } from "../../styles";
import { fetchStringOrUrl, getRewriteUrl } from "../../utility";
import { URL_REWRITERS } from "../BuildImportForm";
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

/** What an error says, ready to show; `failed` ("Open failed") when it says nothing. */
function message(error: unknown, failed: string) {
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

/**
 * The build: paste a PoB code or a pobb.in, poe.ninja, pastebin or maxroll link and
 * Import it, or Open a build file PoB saved (then each save in PoB updates the guide).
 * Edit opens the build in PoB Community, when it's installed; a pasted build is saved as
 * a file first. Loading a build keeps your progress; Unload removes it.
 */
export function BuildCodeForm() {
  const code = useAtomValue(pobAtom);
  const file = useAtomValue(pobFileSelector);
  const loadBuild = useSetAtom(loadBuildAtom);
  const linkFile = useSetAtom(linkBuildFileAtom);
  const unload = useSetAtom(unloadBuildAtom);
  // Empty, with the loaded code as its placeholder: paste a new one without clearing it.
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [importing, setImporting] = useState(false);
  const [confirmUnload, setConfirmUnload] = useState(false);
  /** The name a pasted build gets as a PoB file, while "Save to PoB?" is open. */
  const [saveName, setSaveName] = useState<string | null>(null);
  const [home, setHome] = useState<PobHome | null>(null);
  useEffect(() => {
    let live = true;
    pobHome().then((found) => live && setHome(found));
    return () => {
      live = false;
    };
  }, []);
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
      setError(message(error, "Open failed"));
    } finally {
      setBusy(false);
    }
  };

  const edit = async () => {
    if (code === null) return;
    if (file === null) {
      setSaveName(defaultName(code));
      return;
    }
    setBusy(true);
    try {
      await editBuildFile(file);
      toast.info("PoB opening");
    } catch (error) {
      toast.error(message(error, "PoB not opened"));
    } finally {
      setBusy(false);
    }
  };

  const saveAndEdit = async () => {
    if (code === null || saveName === null) return;
    setSaveName(null);
    setBusy(true);
    try {
      const path = await saveBuildFile(saveName, pobCodeToXml(code));
      // Only if the same build is still loaded (not unloaded or replaced meanwhile).
      if (!linkFile(path, code)) return;
      await editBuildFile(path);
      toast.info("Saved. PoB opening");
    } catch (error) {
      toast.error(message(error, "Not saved"));
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
        <div className={classNames(styles.file)} title={file}>
          <span className={classNames(styles.fileLabel)}>File</span>
          <span className={classNames(styles.fileName)}>
            {buildFileName(file)}
          </span>
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
        {home?.installed && (
          <button
            className={classNames(formStyles.formButton)}
            disabled={code === null || busy}
            onClick={edit}
          >
            Edit
          </button>
        )}
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
            saveAndEdit();
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
    </div>
  );
}
