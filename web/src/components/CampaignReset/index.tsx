import { resetCampaignAtom, resetGemsAtom } from "../../state/pob";
import { formStyles } from "../../styles";
import { Modal } from "../Modal";
import styles from "./styles.module.css";
import classNames from "classnames";
import { useSetAtom } from "jotai";
import { useState } from "react";
import { FaUndoAlt } from "react-icons/fa";
import { toast } from "react-toastify";

/**
 * The Campaign panel's reset: asks first, then clears what Settings' Reset campaign and
 * Reset gems do (campaign ticks, your place and level, gem ticks): a fresh start.
 */
export function CampaignReset() {
  const resetCampaign = useSetAtom(resetCampaignAtom);
  const resetGems = useSetAtom(resetGemsAtom);
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
          <p>Clears campaign and gem ticks, place and level.</p>
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
                resetCampaign();
                resetGems();
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
