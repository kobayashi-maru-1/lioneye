import type { AtlasNode, Plan } from "../lib/types.ts";
import { readLink } from "../lib/links.ts";
import { Modal } from "../../components/Modal";
import { formStyles } from "../../styles";
import styles from "../atlas.module.css";
import classNames from "classnames";
import { flat } from "../lib/text.ts";
import { useEffect, useRef, useState } from "react";

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
            {!allocated ? "Allocate" : picked === null ? "Choose" : "Change"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** One link to copy, with its own Copy button and result. */
function CopyLink({
  label,
  link,
  autoFocus,
}: {
  label: string;
  link: string;
  autoFocus?: boolean;
}) {
  const [copied, setCopied] = useState<"idle" | "done" | "failed">("idle");
  useEffect(() => setCopied("idle"), [link]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied("done");
    } catch {
      setCopied("failed");
    }
  };
  return (
    <div className={styles.copyLink}>
      <div className={styles.copyHead}>
        <span className={styles.heading}>{label}</span>
        {copied !== "idle" && (
          <span className={styles.status} role="status">
            {copied === "done" ? "Copied" : "Not copied. Select and copy."}
          </span>
        )}
        <button
          className={formStyles.formButton}
          onClick={copy}
          autoFocus={autoFocus}
          aria-label={`Copy ${label.toLowerCase()}`}
        >
          Copy
        </button>
      </div>
      <textarea
        className={classNames(formStyles.formInput, styles.linkBox)}
        readOnly
        value={link}
        aria-label={label}
        onFocus={(e) => e.currentTarget.select()}
      />
    </div>
  );
}

/**
 * The plan's links: ours (nodes, choices and budget) and the official pathofexile.com
 * one (nodes only), for the game's site and other tools.
 */
export function ShareDialog({
  links,
  onClose,
}: {
  links: { ours: string; official: string } | null;
  onClose: () => void;
}) {
  if (links === null) return null;
  return (
    <Modal
      size="medium"
      isOpen={true}
      onRequestClose={onClose}
      contentLabel="Share"
    >
      <div className={classNames(formStyles.form, styles.dialog)}>
        <div className={styles.dialogTitle}>Share</div>
        <CopyLink label="Planner link" link={links.ours} autoFocus />
        <CopyLink label="Official link" link={links.official} />
        <div className={styles.tipNote}>Official link: nodes only.</div>
        <div className={formStyles.groupRight}>
          <button className={formStyles.formButton} onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </Modal>
  );
}

const OPEN_ERRORS = {
  invalid: "Not a tree link. Check and paste again.",
  failed: "Not loaded. Check the link and retry.",
  empty: "No atlas tree in that plan. Try another link.",
};

/**
 * Paste a tree link to open: ours, poeatlasplanner.com's, the official one, a
 * poeplanner.com atlas link or a maxroll planner link (fetched, so Open waits for it;
 * Cancel, closing or an edit stops the fetch and drops its answer).
 */
export function OpenDialog({
  isOpen,
  onOpen,
  onClose,
}: {
  isOpen: boolean;
  onOpen: (plan: Plan) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const [state, setState] = useState<
    "idle" | "loading" | keyof typeof OPEN_ERRORS
  >("idle");
  // The read under way: an answer counts only while it's still this one.
  const pending = useRef<AbortController | null>(null);
  const drop = () => {
    pending.current?.abort();
    pending.current = null;
  };
  useEffect(() => {
    drop();
    if (isOpen) {
      setText("");
      setState("idle");
    }
  }, [isOpen]);
  useEffect(() => drop, []);
  if (!isOpen) return null;
  const open = async () => {
    drop();
    const mine = new AbortController();
    pending.current = mine;
    setState("loading");
    let result: Awaited<ReturnType<typeof readLink>>;
    try {
      result = await readLink(text, mine.signal);
    } catch {
      // Never stuck on Loading.
      result = { ok: false, reason: "failed" };
    }
    if (pending.current !== mine) return;
    pending.current = null;
    if (result.ok) {
      setState("idle");
      onOpen(result.plan);
      onClose();
    } else setState("reason" in result ? result.reason : "invalid");
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
            drop();
            setText(e.target.value);
            setState("idle");
          }}
        />
        <div className={formStyles.groupRight}>
          {state === "loading" && (
            <span className={styles.status} role="status">
              Loading
            </span>
          )}
          {state !== "idle" && state !== "loading" && (
            <span
              className={classNames(styles.status, styles.error)}
              role="alert"
            >
              {OPEN_ERRORS[state]}
            </span>
          )}
          <button className={formStyles.formButton} onClick={onClose}>
            Cancel
          </button>
          <button
            className={formStyles.formButton}
            disabled={!text.trim() || state === "loading"}
            onClick={() => void open()}
          >
            Open
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** Asks before an action: deleting a save, or clearing the tree from the start node. */
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
