import { useAtom } from "jotai";
import { searchStringsAtom } from "../../state/search-strings";
import { CodeEditor } from "../CodeEditor";
import { SettingRow } from "../SettingsCard";
import styles from "./styles.module.css";
import classNames from "classnames";
import { type Grammar } from "prismjs";

const SearchStringGrammar: Grammar = {
  comment: /#.*/,
};

/** Settings → Build → Search (the row; the card, with its poe.re link, is Settings'). */
export function SearchStringsEditor() {
  const [searchStrings, setSearchStrings] = useAtom(searchStringsAtom);

  return (
    <SettingRow label="Strings" htmlFor="search-strings">
      <CodeEditor
        className={classNames(styles.input)}
        textareaId="search-strings"
        grammar={SearchStringGrammar}
        placeholder={"# MS boots\nnne|rint"}
        value={searchStrings?.join("\n") || ""}
        onValueChange={(value) => {
          if (value.length == 0) setSearchStrings(null);
          else setSearchStrings(value.split(/\r\n|\r|\n/));
        }}
      />
      <div className={classNames(styles.hint)}>
        A # line names the string below it.
      </div>
    </SettingRow>
  );
}
