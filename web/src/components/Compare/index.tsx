import classNames from "classnames";
import { FaExchangeAlt } from "react-icons/fa";
import { useNavigate } from "react-router-dom";

/** The build header's Compare button: opens the Compare page. */
export function CompareButton({ className }: { className: string }) {
  const navigate = useNavigate();
  return (
    <button className={classNames(className)} onClick={() => navigate("/compare")}>
      <FaExchangeAlt aria-hidden />
      Compare
    </button>
  );
}
