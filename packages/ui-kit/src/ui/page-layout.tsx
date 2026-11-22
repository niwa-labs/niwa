import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { cn } from "../lib/cn.ts";

type HeadingProps = Omit<ComponentPropsWithoutRef<"header">, "title"> & { title: ReactNode; meta?: ReactNode };
/** A page title, its optional context and the controls that belong to this page. */
export function PageHeading({ title, meta, children, className, ...props }: HeadingProps) {
  return (
    <header {...props} className={cn("desk-heading", className)}>
      <div>
        <h1>{title}</h1>
        {meta && <small>{meta}</small>}
      </div>
      {children}
    </header>
  );
}

type SectionProps = Omit<ComponentPropsWithoutRef<"section">, "title"> & { title: ReactNode; actions?: ReactNode };
export function PageSection({ title, actions, children, className, ...props }: SectionProps) {
  return (
    <section {...props} className={cn("desk-section", className)}>
      {actions ? (
        <header className="desk-tools">
          <h2>{title}</h2>
          {actions}
        </header>
      ) : (
        <h2>{title}</h2>
      )}
      {children}
    </section>
  );
}
