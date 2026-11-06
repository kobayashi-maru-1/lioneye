import { pobAtom } from "../../state/pob";
import { processPob } from "../../state/pob/process";
import { formStyles } from "../../styles";
import { fetchStringOrUrl, getRewriteUrl } from "../../utility";
import { URL_REWRITERS } from "../BuildImportForm";
import { Modal } from "../Modal";
import styles from "./styles.module.css";
import classNames from "classnames";
import { useAtomValue } from "jotai";
import { useEffect, useState } from "react";
import { toast } from "react-toastify";

interface BuildCodeFormProps {
  /** A new build's code (it starts a new character: progress resets). */
  onImport: (code: string) => void;
  /** Asks before clearing the build and progress. */
  onReset: () => void;
}

/** True when PoB's code reads as a build (else importing it would reset everything). */
function readable(code: string) {
  try {
    return processPob(code) !== null;
  } catch {
    return false;
  }
}

/**
 * The imported build's PoB code, shown in place: paste another code or a pobb.in,
 * poe.ninja, pastebin or maxroll link and Import it (replacing a loaded build asks first,
 * as it resets your route progress), Copy it, or Reset.
 */
export function BuildCodeForm({ onImport, onReset }: BuildCodeFormProps) {
  const code = useAtomValue(pobAtom);
  // Empty, with the loaded code as its placeholder: paste a new one without clearing it.
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  /** A new code waiting for "Replace build?". */
  const [replacing, setReplacing] = useState<string | null>(null);
  // A new build loaded (or reset): its code shows as the placeholder.
  useEffect(() => {
    setText("");
    setError(null);
  }, [code]);

  const loaded = (code ?? "").trim();
  const changed = text.trim() !== "" && text.trim() !== loaded;

  const apply = (value: string) => {
    onImport(value);
    setText("");
    toast.success("Build imported");
  };

  const importCode = async () => {
    const input = text.trim();
    const isLink = getRewriteUrl(input, URL_REWRITERS) !== null;
    setImporting(true);
    setError(null);
    try {
      const value = (await fetchStringOrUrl(input, URL_REWRITERS)).trim();
      if (!readable(value)) {
        setError("Code not read. Paste a PoB code or link.");
      } else if (value === loaded) {
        // The same build: nothing to replace.
        setText("");
      } else if (code !== null) {
        setReplacing(value);
      } else {
        apply(value);
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
        className={classNames(formStyles.formInput, styles.code)}
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
        <button className={classNames(formStyles.formButton)} onClick={onReset}>
          Reset
        </button>
        <button
          className={classNames(formStyles.formButton)}
          disabled={code === null}
          onClick={copy}
        >
          Copy
        </button>
        <button
          className={classNames(formStyles.formButton)}
          disabled={!changed || importing}
          onClick={importCode}
        >
          {importing ? "Importing…" : "Import"}
        </button>
      </div>
      <Modal
        size="small"
        isOpen={replacing !== null}
        onRequestClose={() => setReplacing(null)}
        contentLabel="Replace build?"
      >
        <div className={classNames(formStyles.form)}>
          <div className={classNames(formStyles.formRow)}>
            <label>Replace build?</label>
          </div>
          <p>Resets your route progress.</p>
          <div className={classNames(formStyles.groupRight)}>
            <button
              className={classNames(formStyles.formButton)}
              autoFocus
              onClick={() => setReplacing(null)}
            >
              Cancel
            </button>
            <button
              className={classNames(formStyles.formButton)}
              onClick={() => {
                if (replacing !== null) apply(replacing);
                setReplacing(null);
              }}
            >
              Replace
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
