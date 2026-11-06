import { pobAtom } from "../../state/pob";
import { pobCodeToXml } from "../../state/pob/process";
import { formStyles } from "../../styles";
import { fetchStringOrUrl } from "../../utility";
import { URL_REWRITERS } from "../BuildImportForm";
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

/**
 * The imported build's PoB code, shown in place: paste another code or a pobb.in,
 * poe.ninja, pastebin or maxroll link and Import it, Copy it, or Reset.
 */
export function BuildCodeForm({ onImport, onReset }: BuildCodeFormProps) {
  const code = useAtomValue(pobAtom);
  const [text, setText] = useState(code ?? "");
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  // A new build loaded (or reset) elsewhere: show it.
  useEffect(() => setText(code ?? ""), [code]);

  const changed = text.trim() !== "" && text.trim() !== (code ?? "");

  const importCode = async () => {
    setImporting(true);
    setError(null);
    try {
      const value = (await fetchStringOrUrl(text.trim(), URL_REWRITERS)).trim();
      try {
        pobCodeToXml(value);
      } catch {
        // A code PoB can't read would reset everything: refuse it instead.
        setError("Code not read. Paste a PoB code or link.");
        return;
      }
      onImport(value);
      toast.success("Build imported");
    } catch {
      setError("Link not loaded. Check it and retry.");
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
      <label htmlFor="pob-code">Path of Building code</label>
      <textarea
        id="pob-code"
        className={classNames(formStyles.formInput, styles.code)}
        spellCheck={false}
        placeholder="PoB code or link"
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      {error && <span className={classNames(styles.error)}>{error}</span>}
      <div className={classNames(formStyles.groupRight, styles.buttons)}>
        <button
          className={classNames(formStyles.formButton)}
          disabled={code === null}
          onClick={onReset}
        >
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
    </div>
  );
}
