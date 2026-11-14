import type { AtlasNode } from "../lib/types.ts";
import { Modal } from "../../components/Modal";
import { formStyles } from "../../styles";
import styles from "../atlas.module.css";
import classNames from "classnames";
import { flat } from "../lib/text.ts";
import { useEffect, useState } from "react";

/** Picks a choice node's option: before allocating it, or to change or refund it. */
export function ChoiceDialog({
  node,
  picked,
  allocated,
  cost,
  over,
  onPick,
  onRefund,
  onClose,
}: {
  node: AtlasNode | null;
  picked: number | null;
  allocated: boolean;
  cost: number;
  over: boolean;
  onPick: (effect: number) => void;
  onRefund: () => void;
  onClose: () => void;
}) {
  // Starts from the node's pick; a new node remounts it (key in App), so it never carries over.
  const [choice, setChoice] = useState<number | null>(picked);
  if (!node) return null;
  return (
    <Modal
      size="large"
      isOpen={true}
      onRequestClose={onClose}
      contentLabel={node.name}
      style={{ content: { height: "auto" } }}
    >
      <div className={classNames(formStyles.form, styles.dialog)}>
        <div className={styles.dialogTitle}>
          {node.name}
          {!allocated && (
            <span
              className={classNames(styles.cost, { [styles.costOver]: over })}
            >
              +{cost}
            </span>
          )}
        </div>
        <div className={styles.options} role="radiogroup" aria-label="Options">
          {node.choices?.map((option) => (
            <label
              key={option.effect}
              className={classNames(styles.option, {
                [styles.optionOn]: choice === option.effect,
              })}
            >
              <input
                type="radio"
                name="choice"
                checked={choice === option.effect}
                onChange={() => setChoice(option.effect)}
              />
              <span>
                {option.stats.map((line, i) => (
                  <span key={i} className={styles.optionLine}>
                    {flat(line)}
                  </span>
                ))}
              </span>
            </label>
          ))}
        </div>
        <div className={formStyles.groupRight}>
          {allocated && (
            <button className={formStyles.formButton} onClick={onRefund}>
              Refund
            </button>
          )}
          <button className={formStyles.formButton} onClick={onClose}>
            Cancel
          </button>
          <button
            className={formStyles.formButton}
            disabled={choice === null || (allocated ? choice === picked : over)}
            onClick={() => choice !== null && onPick(choice)}
          >
            {allocated ? "Change" : "Allocate"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** The plan's share link, to copy. */
export function ShareDialog({
  link,
  onClose,
}: {
  link: string | null;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState<"idle" | "done" | "failed">("idle");
  useEffect(() => setCopied("idle"), [link]);
  if (link === null) return null;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied("done");
    } catch {
      setCopied("failed");
    }
  };
  return (
    <Modal
      size="medium"
      isOpen={true}
      onRequestClose={onClose}
      contentLabel="Share"
    >
      <div className={classNames(formStyles.form, styles.dialog)}>
        <div className={styles.dialogTitle}>Share</div>
        <textarea
          className={classNames(formStyles.formInput, styles.linkBox)}
          readOnly
          value={link}
          aria-label="Link"
          onFocus={(e) => e.currentTarget.select()}
        />
        <div className={formStyles.groupRight}>
          {copied !== "idle" && (
            <span className={styles.status} role="status">
              {copied === "done" ? "Copied" : "Not copied. Select and copy."}
            </span>
          )}
          <button className={formStyles.formButton} onClick={onClose}>
            Close
          </button>
          <button className={formStyles.formButton} onClick={copy} autoFocus>
            Copy
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** Paste a tree link to open: ours, poeatlasplanner.com's or the official one. */
export function OpenDialog({
  isOpen,
  onOpen,
  onClose,
}: {
  isOpen: boolean;
  /** Returns false when the text isn't a tree link. */
  onOpen: (text: string) => boolean;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState(false);
  useEffect(() => {
    if (isOpen) {
      setText("");
      setError(false);
    }
  }, [isOpen]);
  if (!isOpen) return null;
  const open = () => {
    if (onOpen(text)) onClose();
    else setError(true);
  };
  return (
    <Modal
      size="medium"
      isOpen={true}
      onRequestClose={onClose}
      contentLabel="Open"
    >
      <div className={classNames(formStyles.form, styles.dialog)}>
        <div className={styles.dialogTitle}>Open</div>
        <textarea
          className={classNames(formStyles.formInput, styles.linkBox)}
          value={text}
          placeholder="Tree link"
          aria-label="Tree link"
          spellCheck={false}
          autoFocus
          onChange={(e) => {
            setText(e.target.value);
            setError(false);
          }}
        />
        <div className={formStyles.groupRight}>
          {error && (
            <span
              className={classNames(styles.status, styles.error)}
              role="alert"
            >
              Not a tree link. Check and paste again.
            </span>
          )}
          <button className={formStyles.formButton} onClick={onClose}>
            Cancel
          </button>
          <button
            className={formStyles.formButton}
            disabled={!text.trim()}
            onClick={open}
          >
            Open
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** A yes/no for something that can't be undone. */
export function ConfirmDialog({
  title,
  action,
  onConfirm,
  onClose,
}: {
  title: string | null;
  action: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  if (title === null) return null;
  return (
    <Modal
      size="small"
      isOpen={true}
      onRequestClose={onClose}
      contentLabel={title}
    >
      <div className={classNames(formStyles.form, styles.dialog)}>
        <div className={styles.dialogTitle}>{title}</div>
        <div className={formStyles.groupRight}>
          <button className={formStyles.formButton} onClick={onClose} autoFocus>
            Cancel
          </button>
          <button className={formStyles.formButton} onClick={onConfirm}>
            {action}
          </button>
        </div>
      </div>
    </Modal>
  );
}
