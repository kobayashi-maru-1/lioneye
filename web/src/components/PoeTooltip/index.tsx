import styles from "./styles.module.css";
import classNames from "classnames";
import React from "react";

/** Header colours by rarity, like the game's tooltip banners. */
export type TooltipKind = "normal" | "magic" | "rare" | "unique" | "gem";

interface PoeTooltipProps {
  kind: TooltipKind;
  /** First header line (item or gem name). */
  name: React.ReactNode;
  /** Second header line (the base), for rares and uniques. */
  base?: React.ReactNode;
}

/**
 * An in-game style tooltip, as pob.codes draws them: a coloured banner with the name (and
 * base), then sections split by thin rules. Pass sections as children; empty ones are left
 * out.
 */
export function PoeTooltip({
  kind,
  name,
  base,
  children,
}: React.PropsWithChildren<PoeTooltipProps>) {
  const sections = React.Children.toArray(children).filter(Boolean);
  return (
    <div className={classNames(styles.tooltip, styles[kind])}>
      <div className={classNames(styles.header)}>
        <div className={classNames(styles.name)}>{name}</div>
        {base && <div className={classNames(styles.name)}>{base}</div>}
      </div>
      {sections.map((section, i) => (
        <React.Fragment key={i}>
          {i > 0 && <div className={classNames(styles.sep)} />}
          <div className={classNames(styles.section)}>{section}</div>
        </React.Fragment>
      ))}
    </div>
  );
}

/** A grey "Label: value" line with the value in white, like "Requires Level 16". */
export function TooltipProperty({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className={classNames(styles.property)}>
      {label} <span className={classNames(styles.value)}>{value}</span>
    </div>
  );
}

export const tooltipStyles = styles;
