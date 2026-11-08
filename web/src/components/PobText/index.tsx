import { pobSpans } from "../../state/pob/colour";

export { stripPob } from "../../state/pob/colour";

/** PoB text in PoB's colours. */
export function PobText({ text }: { text: string }) {
  return (
    <>
      {pobSpans(text).map((span, i) => (
        <span key={i} style={{ color: span.colour }}>
          {span.text}
        </span>
      ))}
    </>
  );
}
