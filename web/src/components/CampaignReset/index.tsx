import { resetCampaignAtom } from "../../state/pob";
import { formStyles } from "../../styles";
import { Modal } from "../Modal";
import styles from "./styles.module.css";
import classNames from "classnames";
import { useSetAtom } from "jotai";
import { useState } from "react";
import { FaUndoAlt } from "react-icons/fa";
import { toast } from "react-toastify";

/**
 * The Campaign panel's reset: asks first, then clears what Settings' Reset campaign does
 * (campaign ticks, your place and level). Gem ticks stay.
 */
export function CampaignReset() {
  const reset = useSetAtom(resetCampaignAtom);
  const [asking, setAsking] = useState(false);
  return (
    <>
      <button
        className={classNames(styles.button)}
        title="Reset campaign"
        aria-label="Reset campaign"
        onClick={() => setAsking(true)}
      >
        <FaUndoAlt aria-hidden />
      </button>
      <Modal
        size="small"
        isOpen={asking}
        onRequestClose={() => setAsking(false)}
        contentLabel="Reset campaign?"
      >
        <div className={classNames(formStyles.form)}>
          <div className={classNames(formStyles.formRow)}>
            <label>Reset campaign?</label>
          </div>
          <p>Clears campaign ticks, your place and level.</p>
          <div className={classNames(formStyles.groupRight)}>
            <button
              className={classNames(formStyles.formButton)}
              autoFocus
              onClick={() => setAsking(false)}
            >
              Cancel
            </button>
            <button
              className={classNames(formStyles.formButton)}
              onClick={() => {
                reset();
                setAsking(false);
                toast.success("Campaign reset");
              }}
            >
              Reset
            </button>
          </div>
        </div>
      </Modal>
    </>
  );
}
