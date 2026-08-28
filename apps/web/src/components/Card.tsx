import type { HTMLAttributes, ReactNode } from 'react';

export interface CardProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  title?: ReactNode;
  /** Right-aligned slot next to the title (e.g. <SimBadge/> or a status chip). */
  action?: ReactNode;
  /** Render as a semantic element; default 'section'. */
  as?: 'section' | 'article' | 'div';
  children?: ReactNode;
}

/** Rounded white panel used for batch tiles, recommendation blocks, settings groups. */
export function Card({ title, action, as: Tag = 'section', className = '', children, ...rest }: CardProps): JSX.Element {
  return (
    <Tag className={`card ${className}`} {...rest}>
      {(title || action) && (
        <header className="mb-3 flex items-center justify-between gap-2">
          {title ? <h2 className="text-lg font-semibold">{title}</h2> : <span />}
          {action}
        </header>
      )}
      {children}
    </Tag>
  );
}

export default Card;
