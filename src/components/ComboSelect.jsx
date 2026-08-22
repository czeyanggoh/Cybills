import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

// Type-to-find dropdown. Same contract as the native <select> it replaces —
// a list of string values, plus a `format` for how each one is shown — but the
// closed control is a text box, so a 200-line chart of accounts is reached by
// typing "437" or "interest" instead of scrolling to it.
//
// The list is rendered in a portal at fixed coordinates rather than absolutely
// inside the field. Several of these sit inside `overflow-x-auto` containers
// (the line-item table), where an absolutely positioned menu is clipped out of
// existence.

const norm = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

// Every whitespace-separated token must appear somewhere in the option. Both
// the stored value and its formatted label are searched, so "437" still finds
// the account when the display mode is showing names only.
function matches(query, value, label) {
  const q = norm(query);
  if (!q) return true;
  const hay = `${norm(value)} ${norm(label)}`;
  return q.split(' ').every((t) => hay.includes(t));
}

const MENU_MAX = 288; // max-h-72

export default function ComboSelect({
  value,
  options,
  onChange,
  format = (x) => x,
  placeholder = 'Type to search…',
  emptyLabel = '',
  disabled = false,
  size = 'md',
  className = '',
  'aria-label': ariaLabel,
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [rect, setRect] = useState(null);
  const inputRef = useRef(null);
  const listRef = useRef(null);

  // The current value first (so it's the first thing seen on open), then
  // everything else in the order given. An unknown value — a free-text
  // category, or one since removed from Xero — is kept so it stays selectable.
  const all = useMemo(() => {
    const rest = options.filter((o) => o !== value);
    return value ? [value, ...rest] : rest;
  }, [options, value]);

  const shown = useMemo(
    () => all.filter((o) => matches(query, o, format(o))),
    // `format` is usually an inline arrow, so it can't be a dependency without
    // refiltering on every render.
    [all, query]
  );

  const place = useCallback(() => {
    const r = inputRef.current?.getBoundingClientRect();
    if (!r) return;
    const below = window.innerHeight - r.bottom;
    const flip = below < 180 && r.top > below;
    setRect({
      left: r.left,
      width: r.width,
      top: flip ? null : r.bottom + 4,
      bottom: flip ? window.innerHeight - r.top + 4 : null,
      maxHeight: Math.max(120, Math.min(MENU_MAX, (flip ? r.top : below) - 12)),
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) return undefined;
    place();
    // `true` — capture, so scrolling any ancestor keeps the menu on the field.
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [open, active, shown.length]);

  const start = () => {
    if (disabled) return;
    setQuery('');
    setActive(Math.max(0, all.indexOf(value)));
    setOpen(true);
  };

  const close = () => {
    setOpen(false);
    setQuery('');
  };

  const commit = (v) => {
    close();
    if (v !== value) onChange(v);
  };

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) return start();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      return setActive((i) => {
        if (!shown.length) return 0;
        const next = i + step;
        return next < 0 ? shown.length - 1 : next >= shown.length ? 0 : next;
      });
    }
    if (e.key === 'Enter') {
      if (!open) return;
      e.preventDefault();
      if (shown[active] !== undefined) commit(shown[active]);
      return;
    }
    if (e.key === 'Escape') {
      if (!open) return;
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (e.key === 'Tab' && open) close();
  };

  const box = {
    md: 'h-9 px-3 pr-8',
    sm: 'h-8 min-w-[9rem] rounded px-2 pr-7',
    xs: 'h-[30px] px-2 pr-7 text-xs',
  }[size] || 'h-9 px-3 pr-8';

  return (
    <div className={cn('relative', className)}>
      <input
        ref={inputRef}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        aria-label={ariaLabel}
        disabled={disabled}
        // Closed, this reads as the field's value; open, it's the search box.
        value={open ? query : format(value)}
        placeholder={open ? placeholder : emptyLabel}
        onChange={(e) => {
          if (!open) start();
          setQuery(e.target.value);
          setActive(0);
        }}
        onMouseDown={() => { if (!open) start(); }}
        onFocus={start}
        onBlur={close}
        onKeyDown={onKeyDown}
        className={cn(
          'w-full cursor-text rounded-md border bg-background text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:bg-muted disabled:text-muted-foreground',
          box
        )}
      />
      <ChevronDown
        className={cn(
          'pointer-events-none absolute top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground',
          size === 'md' ? 'right-3' : 'right-2'
        )}
      />
      {open && rect && createPortal(
        <ul
          ref={listRef}
          role="listbox"
          // Keep focus on the input: a blur would close the menu before the
          // click ever lands on an option.
          onMouseDown={(e) => e.preventDefault()}
          style={{
            position: 'fixed',
            left: rect.left,
            width: rect.width,
            ...(rect.top === null ? { bottom: rect.bottom } : { top: rect.top }),
            maxHeight: rect.maxHeight,
          }}
          className="z-[100] overflow-y-auto rounded-md border bg-popover py-1 text-sm shadow-md"
        >
          {shown.length === 0 && (
            <li className="px-3 py-2 text-muted-foreground">No match</li>
          )}
          {shown.map((o, i) => (
            <li
              key={o}
              role="option"
              aria-selected={o === value}
              data-active={i === active}
              onMouseEnter={() => setActive(i)}
              onClick={() => commit(o)}
              className={cn(
                'flex cursor-pointer items-center gap-2 px-3 py-1.5',
                i === active && 'bg-accent text-accent-foreground'
              )}
            >
              <Check className={cn('h-3.5 w-3.5 shrink-0', o === value ? 'opacity-100' : 'opacity-0')} />
              <span className="truncate">{format(o) || <span className="text-muted-foreground">(blank)</span>}</span>
            </li>
          ))}
        </ul>,
        document.body
      )}
    </div>
  );
}
